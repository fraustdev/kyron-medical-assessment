/**
 * The turn loop. One run = one scenario x one agent x one caller.
 *
 *   caller speaks -> agent responds; while the agent asks for tools, run them and feed the results back
 *   -> agent speaks -> repeat, until: the caller ends the call (stop_condition / emergency_instruction),
 *   the caller turn cap is reached (turn_cap), a tool ends the call (transfer), or the agent hangs up.
 *
 * The runner RECORDS. It never judges what the agent did. The only statuses it assigns are about whether the
 * run itself completed (completed / turn_cap_hit / agent_error / harness_error); sim_untrustworthy comes in M6.
 */
import { randomBytes } from "node:crypto";
import { sha256 } from "../llm/cache.js";
import type { Agent, ExecutedToolCall, Message } from "../agents/types.js";
import { ScriptExhaustedError } from "../agents/scripted.js";
import type { Caller, CallerUtterance } from "../caller/types.js";
import type { LlmCallInfo, RunMode, RunStatus, Trace } from "../trace/types.js";
import { TRACE_VERSION } from "../trace/types.js";
import { validateTrace } from "../trace/validate.js";
import { HARNESS_VERSION } from "../version.js";
import type { LoadedDataset, Scenario } from "../world/dataset.js";
import { createWorld, finalSnapshot, Recorder } from "../world/index.js";

/** caller_sim_instructions: "Hard cap: 30 caller turns". */
export const DEFAULT_TURN_CAP = 30;
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

export interface RunOptions {
  dataset: LoadedDataset;
  scenario: Scenario;
  agent: Agent;
  caller: Caller;
  mode: RunMode;
  seed?: number;
  trialIndex?: number;
  /** Max caller turns. Defaults to the scenario's "Caller has made N turns" stop condition, else 30. */
  turnCap?: number;
  /** Max agent->tool->agent rounds within one turn before the run is stopped as an agent error. */
  maxToolRounds?: number;
}

/** The scenario's own turn cap, from a stop condition like "Caller has made 12 turns." */
export function turnCapFor(scenario: Scenario): number {
  for (const c of scenario.caller_stop_conditions) {
    const m = /Caller has made (\d+) turns/i.exec(c);
    if (m) return Number(m[1]);
  }
  return DEFAULT_TURN_CAP;
}


export class AgentLoopError extends Error {
  constructor(rounds: number) { super(`agent requested tools for more than ${rounds} rounds in one turn`); this.name = "AgentLoopError"; }
}

export async function runScenario(o: RunOptions): Promise<Trace> {
  const startedAt = new Date();
  const recorder = new Recorder();
  const world = createWorld(o.dataset, o.scenario, recorder);
  const toolbox = world.toolbox();
  const toolDefs = toolbox.toolDefs();
  /** Read fresh each time: any tool call can end the call (TS would otherwise narrow this to a constant). */
  const endedBy = () => world.callEndedBy;
  const turnCap = o.turnCap ?? turnCapFor(o.scenario);
  const maxRounds = o.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const conversation: Message[] = [];
  let status: RunStatus = "completed";
  let callerTurns = 0;

  for (let turn = 0; ; turn++) {
    recorder.turn = turn;

    // ---------------------------------------------------------------- caller
    if (callerTurns >= turnCap) {
      recorder.emit({ type: "call_end", reason: "turn_cap", detail: `Caller turn cap of ${turnCap} reached.` });
      status = "turn_cap_hit";
      break;
    }
    let utt: CallerUtterance | null;
    try {
      utt = await o.caller.next({ turn, conversation, events: recorder.events });
    } catch (e) {
      recorder.emit({ type: "error", source: "caller", message: errMsg(e), fatal: true });
      status = "harness_error";
      break;
    }
    if (utt === null) {
      recorder.emit({ type: "call_end", reason: "stop_condition", detail: "The caller ended the call." });
      break;
    }
    if (utt.director) recorder.emit({ type: "director_decision", ...utt.director });
    recorder.emit({ type: "caller_turn", text: utt.text, source: o.caller.info().type, ...(utt.llm_calls?.length ? { llm_calls: utt.llm_calls } : {}) });
    conversation.push({ role: "caller", text: utt.text });
    callerTurns += 1;
    if (utt.hang_up_after) {
      recorder.emit({ type: "call_end", reason: utt.end_reason ?? "stop_condition", detail: utt.end_detail ?? "The caller hung up." });
      break;
    }

    // ---------------------------------------------------------------- agent (tool rounds, then speech)
    const toolCallIds: string[] = [];
    const spoken: string[] = [];
    let finalText = "";
    let endCall = false;
    let llm: LlmCallInfo | undefined;
    const llmCalls: LlmCallInfo[] = [];
    let raw: unknown;
    try {
      for (let round = 1; ; round++) {
        if (round > maxRounds) throw new AgentLoopError(maxRounds);
        const r = await o.agent.respond(conversation, toolDefs);
        if (r.llm) {
          llm = r.llm;
          llmCalls.push(r.llm);
          // The model's response time is part of what the caller experiences. It comes from the cache entry on
          // replay, so the virtual timeline is identical in live and replay runs.
          recorder.clock.advance(r.llm.latency_ms);
        }
        if (r.raw !== null && r.raw !== undefined) raw = r.raw;
        if (r.text.trim()) spoken.push(r.text.trim());

        if (r.tool_calls.length === 0 || endedBy()) {
          if (r.tool_calls.length > 0) {
            recorder.emit({ type: "error", source: "harness", fatal: false,
              message: `Ignored ${r.tool_calls.length} tool call(s) requested after ${endedBy()?.tool} ended the call.` });
          }
          endCall = r.end_call === true;
          finalText = r.text.trim();
          break;
        }

        const executed: ExecutedToolCall[] = [];
        const results: Message[] = [];
        for (const tc of r.tool_calls) {
          if (endedBy()) {
            recorder.emit({ type: "error", source: "harness", fatal: false,
              message: `Ignored ${tc.tool}: requested after ${endedBy()?.tool} ended the call.` });
            continue;
          }
          const res = toolbox.callTool(tc.tool, tc.args);
          toolCallIds.push(res.call_id);
          executed.push({ call_id: res.call_id, tool: tc.tool, args: tc.args });
          results.push({ role: "tool", call_id: res.call_id, tool: res.tool, result: res.result });
        }
        conversation.push({ role: "agent", text: r.text, tool_calls: executed }, ...results);
      }
    } catch (e) {
      recorder.emit({ type: "error", source: "agent", message: errMsg(e), fatal: true });
      status = e instanceof ScriptExhaustedError ? "harness_error" : "agent_error";
      break;
    }

    // The trace records everything the agent said this turn. The conversation already holds the text spoken
    // alongside tool calls, so only the final response is appended (otherwise the model would see itself repeat).
    const text = spoken.join(" ");
    recorder.emit({ type: "agent_turn", text, tool_call_ids: toolCallIds, ...(llm ? { llm, llm_calls: llmCalls } : {}), ...(raw !== undefined ? { raw } : {}) });
    conversation.push({ role: "agent", text: finalText, tool_calls: [] });

    if (world.callEndedBy) {
      const { tool, handoff } = world.callEndedBy;
      recorder.emit({ type: "call_end", reason: "transfer", detail: `The agent's part of the call ended with ${tool}.`, ...(handoff ? { handoff } : {}) });
      break;
    }
    if (endCall) {
      recorder.emit({ type: "call_end", reason: "agent_hangup", detail: "The agent ended the call." });
      break;
    }
  }

  const agentInfo = o.agent.info();
  const callerInfo = o.caller.info();
  const trace: Trace = {
    trace_version: TRACE_VERSION,
    metadata: {
      run_id: `run_${o.scenario.id}_${agentInfo.id}_t${o.trialIndex ?? 0}_${startedAt.getTime().toString(36)}${randomBytes(2).toString("hex")}`,
      scenario_id: o.scenario.id,
      dataset: { name: o.dataset.data.dataset, version: o.dataset.data.version, file_sha256: o.dataset.sha256 },
      agent: {
        id: agentInfo.id, version: agentInfo.version, provider: agentInfo.provider, model: agentInfo.model,
        prompt_sha256: agentInfo.prompt_text === null ? null : sha256(agentInfo.prompt_text), prompt_text: agentInfo.prompt_text,
      },
      caller: { ...callerInfo },
      seed: o.seed ?? 0,
      trial_index: o.trialIndex ?? 0,
      mode: o.mode,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      run_status: status,
      harness_version: HARNESS_VERSION,
      turn_cap: turnCap,
      simulated_now: o.dataset.data.simulated_now,
    },
    events: recorder.events,
    final: finalSnapshot(world, recorder),
  };

  const check = validateTrace(trace);
  if (!check.valid) throw new Error(`harness bug: produced an invalid trace for ${o.scenario.id}:\n  ${check.errors.join("\n  ")}`);
  return trace;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
