/** Turn-loop behavior that the goldens don't cover: every way a call can end, errors, and what the agent sees. */
import { describe, expect, it } from "vitest";
import { ScriptedAgent } from "../src/agents/scripted.js";
import type { Agent, AgentResponse, Message } from "../src/agents/types.js";
import { ScriptedCaller } from "../src/caller/scripted.js";
import { runScenario, turnCapFor } from "../src/runner/runner.js";
import type { Trace, TraceEvent } from "../src/trace/types.js";
import { validateTrace } from "../src/trace/validate.js";
import { getScenario, loadDataset, type DatasetKey } from "../src/world/dataset.js";

const of = <T extends TraceEvent["type"]>(t: Trace, type: T) => t.events.filter((e) => e.type === type) as Extract<TraceEvent, { type: T }>[];
const say = (text: string) => ({ text, tool_calls: [] });

async function run(key: DatasetKey, id: string, agent: Agent, lines: string[], hangUp = false, turnCap?: number) {
  const dataset = loadDataset(key);
  const trace = await runScenario({ dataset, scenario: getScenario(dataset, id), agent, caller: new ScriptedCaller(lines, hangUp), mode: "scripted", ...(turnCap ? { turnCap } : {}) });
  expect(validateTrace(trace).errors).toEqual([]);                   // every ending must still produce a valid trace
  return trace;
}

describe("turn cap", () => {
  it("comes from the scenario's 'Caller has made N turns' stop condition (else 30)", () => {
    expect(turnCapFor(getScenario(loadDataset("pharmacy"), "S10"))).toBe(12);
    expect(turnCapFor(getScenario(loadDataset("pharmacy"), "S01"))).toBe(30);
  });
  it("ends the call with turn_cap and run_status turn_cap_hit", async () => {
    const agent = new ScriptedAgent(Array.from({ length: 20 }, () => say("Mm-hm.")));
    const t = await run("pharmacy", "S10", agent, Array.from({ length: 20 }, (_, i) => `line ${i}`));
    expect(of(t, "caller_turn")).toHaveLength(12);
    expect(of(t, "call_end")[0]).toMatchObject({ reason: "turn_cap" });
    expect(t.metadata.run_status).toBe("turn_cap_hit");
  });
});

describe("call endings", () => {
  it("a nurse-line transfer ends the call with a handoff, and later tool calls are ignored", async () => {
    const agent = new ScriptedAgent([{ text: "I'm connecting you to our nurse now.", tool_calls: [
      { tool: "transfer_to_nurse_line", args: { patient: "Tess Morgan", reason: "chest tightness, more ankle swelling" } },
      { tool: "book_appointment", args: { patient: "Tess Morgan", slot_id: "RAO-20260929-0920", visit_type: "follow_up" } },
    ] }]);
    const t = await run("scheduling", "A07", agent, ["Hi honey, Tess Morgan.", "(never said)"]);
    expect(of(t, "call_end")[0]).toMatchObject({ reason: "transfer", handoff: { to: "nurse_line" } });
    expect(of(t, "tool_call").map((e) => e.tool)).toEqual(["transfer_to_nurse_line"]);
    expect(of(t, "error")[0]).toMatchObject({ source: "harness", fatal: false });
    expect(t.final.end_state.bookings).toEqual([]);
    expect(of(t, "caller_turn")).toHaveLength(1);
  });
  it("the agent can hang up", async () => {
    const t = await run("pharmacy", "S01", new ScriptedAgent([{ ...say("Goodbye."), end_call: true }]), ["Hello?", "Wait!"]);
    expect(of(t, "call_end")[0]).toMatchObject({ reason: "agent_hangup" });
  });
  it("the caller can hang up after a line, with no agent reply", async () => {
    const t = await run("pharmacy", "S01", new ScriptedAgent([say("Hi.")]), ["Hello?", "Never mind, bye."], true);
    expect(of(t, "agent_turn")).toHaveLength(1);
    expect(of(t, "call_end")[0]).toMatchObject({ reason: "stop_condition" });
  });
});

describe("errors", () => {
  it("an agent exception stops the run as agent_error, and the trace is still saved and valid", async () => {
    const broken: Agent = { info: () => ({ id: "broken", version: "0", provider: null, model: null, prompt_text: null }),
      respond: async () => { throw new Error("provider 500"); } };
    const t = await run("pharmacy", "S01", broken, ["Hello?"]);
    expect(t.metadata.run_status).toBe("agent_error");
    expect(of(t, "error")[0]).toMatchObject({ source: "agent", fatal: true });
  });
  it("an agent that never stops calling tools is cut off as agent_error", async () => {
    const looping: Agent = { info: () => ({ id: "loop", version: "0", provider: null, model: null, prompt_text: null }),
      respond: async () => ({ text: "", tool_calls: [{ tool: "find_stores", args: { query: "Harbor" } }], raw: null }) };
    const t = await run("pharmacy", "S01", looping, ["Hello?"]);
    expect(t.metadata.run_status).toBe("agent_error");
    expect(of(t, "tool_call")).toHaveLength(8);
  });
  it("a scripted agent that runs out of lines is a harness_error (a broken script, not an agent failure)", async () => {
    const t = await run("pharmacy", "S01", new ScriptedAgent([say("Hi.")]), ["Hello?", "Are you there?"]);
    expect(t.metadata.run_status).toBe("harness_error");
  });
});

describe("what the agent sees", () => {
  it("gets tool results fed back within the turn, and never sees fixture data except through them", async () => {
    const seen: Message[][] = [];
    let step = 0;
    const spy: Agent = {
      info: () => ({ id: "spy", version: "0", provider: null, model: null, prompt_text: null }),
      respond: async (conv): Promise<AgentResponse> => {
        seen.push(structuredClone(conv as Message[]));
        step++;
        if (step === 1) return { text: "One moment.", tool_calls: [{ tool: "verify_identity", args: { patient: "Gloria Hart", dob: "1947-05-12" } }], raw: null };
        if (step === 2) return { text: "", tool_calls: [{ tool: "list_prescriptions", args: { patient: "Gloria Hart" } }], raw: null };
        return { text: "You have amlodipine on file.", tool_calls: [], raw: null };
      },
    };
    const t = await run("pharmacy", "S01", spy, ["Hi, Gloria Hart."], false);
    expect(seen[0]).toEqual([{ role: "caller", text: "Hi, Gloria Hart." }]);               // turn start: only the caller's words
    expect(seen[1]!.at(-1)).toMatchObject({ role: "tool", tool: "verify_identity" });     // round 2 sees round 1's result
    expect(seen[2]!.at(-1)).toMatchObject({ role: "tool", tool: "list_prescriptions" });
    expect(of(t, "agent_turn")[0]).toMatchObject({ text: "One moment. You have amlodipine on file.", tool_call_ids: ["c1", "c2"] });
  });
});
