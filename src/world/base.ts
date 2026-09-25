/**
 * BaseWorld: the one pipeline every mock tool call goes through.
 *
 *   tool_call event -> validate args -> pick fault -> handler PLANS an outcome (no mutation)
 *   -> fault decides what is committed and what the agent sees -> tool_result event
 *   -> committed mutations applied, one state_change event each -> identity_verified recomputed.
 *
 * Handlers never mutate the world directly; they return Mutations. That is what makes faults exact:
 * a silent_noop returns the planned result but commits nothing, a committed timeout commits but reports a timeout.
 *
 * Isolation: the fixture lives only inside the world. Agents get an AgentToolbox (toolDefs + callTool) and
 * nothing else; see toolbox().
 */
import type { AppliedFault, Handoff, NormalizedFields, ResultCode, StateOp, ToolCallSummary } from "../trace/types.js";
import { HANDOFF_TOOLS } from "../trace/types.js";
import type { LoadedDataset, Scenario } from "./dataset.js";
import { stateCollections } from "./dataset.js";
import { FaultInjector, type MatchedFault } from "./faults.js";
import type { Recorder } from "./recorder.js";
import { normName } from "./util.js";

export interface ToolParam { name: string; type: "string" | "object"; required: boolean; description: string }
export interface ToolDef { name: string; description: string; params: ToolParam[] }

export interface Mutation {
  collection: string;
  op: StateOp;
  before: unknown;
  after: unknown;
  apply: () => void;
}

export interface ToolOutcome {
  code: ResultCode;
  result: unknown;
  mutations: Mutation[];
  handoff?: Handoff;
  /** The tool ends the agent's part of the call (e.g. a warm transfer). */
  endsCall?: boolean;
  /** Patients this call touched (read or written), for identity_verified. */
  touched?: string[];
  /** Patient verified by this call (verify_identity only). */
  verified?: string;
}

export interface Handler {
  def: ToolDef;
  write: boolean;
  normalize: (args: Record<string, unknown>) => NormalizedFields;
  run: (args: Record<string, unknown>) => ToolOutcome;
}

/** What the agent gets back from a tool call. */
export interface AgentToolResult { call_id: string; tool: string; result: unknown }

/** The ONLY surface an agent can see. */
export interface AgentToolbox {
  toolDefs(): ToolDef[];
  callTool(tool: string, args: Record<string, unknown>): AgentToolResult;
}

export const DEFAULT_LATENCY_MS = { read: 50, write: 120 } as const;

export function err(code: string, message: string): ToolOutcome {
  return { code: `error:${code}`, result: { error: code, message }, mutations: [] };
}

export function addRecord(collections: Record<string, unknown[]>, collection: string, record: Record<string, unknown>): Mutation {
  return { collection, op: "add", before: null, after: record, apply: () => { collections[collection]!.push(record); } };
}

export abstract class BaseWorld {
  protected readonly collections: Record<string, unknown[]> = {};
  protected readonly verifiedPatients = new Set<string>();
  protected readonly touchedPatients = new Set<string>();
  private identityVerified = false;
  private callSeq = 0;
  private readonly faults: FaultInjector;
  private readonly toolCalls: ToolCallSummary[] = [];
  /** Set when a tool ended the agent's part of the call (the runner reads it). */
  callEndedBy: { tool: string; handoff?: Handoff } | null = null;

  protected abstract readonly handlers: Record<string, Handler>;

  constructor(readonly dataset: LoadedDataset, readonly scenario: Scenario, protected readonly recorder: Recorder) {
    for (const c of stateCollections(dataset.data)) this.collections[c] = [];
    this.faults = new FaultInjector(scenario.tool_faults ?? []);
  }

  // ------------------------------------------------------------------ agent surface
  toolbox(): AgentToolbox {
    return Object.freeze({
      toolDefs: () => this.toolDefs(),
      callTool: (tool: string, args: Record<string, unknown>) => this.callTool(tool, args),
    });
  }

  toolDefs(): ToolDef[] {
    return Object.values(this.handlers).map((h) => structuredClone(h.def));
  }

  implementedTools(): string[] { return Object.keys(this.handlers); }

  // ------------------------------------------------------------------ the pipeline
  callTool(tool: string, rawArgs: Record<string, unknown>): AgentToolResult {
    const call_id = `c${++this.callSeq}`;
    const args = rawArgs && typeof rawArgs === "object" ? { ...rawArgs } : {};
    const h = this.handlers[tool];

    let normalized: NormalizedFields = {};
    if (h) {
      try { normalized = h.normalize(args); } catch { normalized = {}; }
      // A field that applies to this tool but could not be read (e.g. a missing argument) is recorded as null.
      normalized = Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, typeof v === "string" ? v : null])) as NormalizedFields;
    }
    const callEv = this.recorder.emit({ type: "tool_call", call_id, tool, args, normalized });

    let outcome: ToolOutcome;
    let matched: MatchedFault | null = null;
    if (!h) {
      outcome = err("unknown_tool", `No tool named ${tool}.`);
    } else {
      const missing = h.def.params.filter((p) => p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === ""));
      matched = this.faults.next(tool, args);
      outcome = missing.length
        ? err("invalid_args", `Missing required argument(s): ${missing.map((p) => p.name).join(", ")}.`)
        : h.run(args);
    }

    // ---- apply the fault (if any): decide what commits and what the agent sees
    const baseLatency = h?.write ? DEFAULT_LATENCY_MS.write : DEFAULT_LATENCY_MS.read;
    let latency: number = baseLatency;
    let commit = outcome.code === "success";
    let agentResult: unknown = outcome.result;
    let code: ResultCode = outcome.code;
    let fault_applied: AppliedFault | null = null;
    let mutations = outcome.mutations;

    if (matched) {
      const { fault, index } = matched;
      fault_applied = { fault_index: index, behavior: fault.behavior };
      if (fault.value !== undefined) fault_applied.value = fault.value;
      const v = (fault.value ?? {}) as Record<string, unknown>;
      switch (fault.behavior) {
        case "timeout": {
          const committed = v.committed === true;
          fault_applied.committed = committed;
          commit = commit && committed;
          latency = typeof v.after_ms === "number" ? v.after_ms : 8000;
          code = "timeout";
          agentResult = { error: "timeout", message: "The system did not respond in time. The request may or may not have gone through." };
          break;
        }
        case "error": {
          const c = String(v.code ?? "SYSTEM_ERROR").toLowerCase();
          commit = false;
          code = `error:${c}`;
          agentResult = { error: c, message: "The system returned an error." };
          break;
        }
        case "returns_pending": {
          mutations = mutations.map((m) => withPendingStatus(m));
          if (agentResult && typeof agentResult === "object" && "status" in (agentResult as object)) {
            agentResult = { ...(agentResult as object), status: "pending_pharmacist" };
          }
          break;
        }
        case "silent_noop": {
          commit = false;   // the agent still sees the planned success result
          break;
        }
        case "latency_ms": {
          latency = typeof fault.value === "number" ? fault.value : baseLatency;
          break;
        }
        case "returns_empty": {
          agentResult = emptyArrays(agentResult);
          break;
        }
      }
    }

    this.recorder.clock.advance(latency);
    const handoff = code === "success" && commit ? outcome.handoff : undefined;
    const resultEv = {
      type: "tool_result" as const, call_id, tool, result: agentResult, result_code: code, fault_applied, latency_ms: latency,
      ...(handoff ? { handoff } : {}),
    };
    if ((HANDOFF_TOOLS as readonly string[]).includes(tool) && code === "success" && !handoff) {
      if (fault_applied?.behavior !== "silent_noop") throw new Error(`harness bug: ${tool} succeeded without a handoff payload`);
      // The agent believes it handed off, but nothing was delivered. Record that truthfully instead of faking a payload.
      (resultEv as Record<string, unknown>).handoff = {
        to: HANDOFF_TARGET[tool] ?? "clinic_staff", reason: "NOT DELIVERED (silent_noop fault)", context_passed: {}, via_tool: tool,
      };
    }
    this.recorder.emit(resultEv);

    if (commit) {
      for (const m of mutations) {
        m.apply();
        this.recorder.emit({ type: "state_change", collection: m.collection, op: m.op, before: m.before, after: m.after, call_id });
      }
      if (outcome.verified) this.verifiedPatients.add(outcome.verified);
      for (const p of outcome.touched ?? []) this.touchedPatients.add(p);
      this.refreshIdentity(call_id);
      if (outcome.endsCall && code === "success") this.callEndedBy = { tool, ...(handoff ? { handoff } : {}) };
    }

    this.toolCalls.push({ seq: callEv.seq, call_id, tool, args, result_code: code });
    return { call_id, tool, result: structuredClone(agentResult) };
  }

  private refreshIdentity(call_id: string): void {
    const now = this.verifiedPatients.size > 0 && [...this.touchedPatients].every((p) => this.verifiedPatients.has(p));
    if (now !== this.identityVerified) {
      this.recorder.emit({ type: "state_change", collection: "identity_verified", op: "set", before: this.identityVerified, after: now, call_id });
      this.identityVerified = now;
    }
  }

  // ------------------------------------------------------------------ helpers for subclasses
  protected isVerified(patient: string): boolean { return this.verifiedPatients.has(patient); }

  /** Resolve a patient name (case/punctuation-insensitive) to the fixture's canonical name. */
  protected resolvePatient(name: unknown, names: string[]): string | null {
    if (typeof name !== "string") return null;
    const n = normName(name);
    return names.find((x) => normName(x) === n) ?? null;
  }

  // ------------------------------------------------------------------ final snapshot
  endState(): { identity_verified: boolean } & Record<string, unknown> {
    return { identity_verified: this.identityVerified, ...structuredClone(this.collections) };
  }
  abstract worldState(): Record<string, unknown>;
  toolCallSummaries(): ToolCallSummary[] { return structuredClone(this.toolCalls); }
}

const HANDOFF_TARGET: Record<string, Handoff["to"]> = {
  transfer_to_nurse_line: "nurse_line", flag_callback: "clinic_staff", flag_pharmacist_callback: "pharmacist",
};

function withPendingStatus(m: Mutation): Mutation {
  if (!m.after || typeof m.after !== "object" || !("status" in (m.after as object))) return m;
  const after = { ...(m.after as Record<string, unknown>), status: "pending_pharmacist" };
  const original = m.apply;
  return {
    ...m, after,
    apply: () => {
      original();
      // the record object pushed by `original` is m.after; update it in place to the pending status
      Object.assign(m.after as object, { status: "pending_pharmacist" });
    },
  };
}

function emptyArrays(result: unknown): unknown {
  if (Array.isArray(result)) return [];
  if (result && typeof result === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) out[k] = Array.isArray(v) ? [] : v;
    return out;
  }
  return result;
}
