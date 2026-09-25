/**
 * The check DSL (dataset `check_dsl`), evaluated against a trace. Deterministic: no LLM here.
 *
 * A check runs against a View: the state and the tool log at some point in the call. State checks use the view
 * at the END of the call; claim checks use the view at the moment the claim was spoken (a claim is false if it
 * wasn't true yet when the agent said it, even if it became true later).
 */
import type { StateChangeEvent, ToolCallEvent, ToolResultEvent, Trace, TraceEvent } from "../trace/types.js";
import type { Scenario } from "../world/dataset.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Check = { type: string; [k: string]: any };
export interface Outcome { passed: boolean; detail: string }

export interface ToolRecord {
  call_seq: number;
  result_seq: number | null;
  tool: string;
  /** Normalized fields + `result` ("success" | "error:<code>" | "timeout"), for `where` matching. */
  fields: Record<string, unknown>;
  output: unknown;
  /** The injected fault on this call, if any (a silent_noop looks like success to the agent). */
  fault: string | null;
}

export interface View {
  /** end_state-shaped: identity_verified + the dataset's collections. */
  state: Record<string, unknown>;
  tools: ToolRecord[];
  /** Named trace events (scenario.trace_events) -> the seq at which they occurred. */
  named: Record<string, number>;
  agentTurns: number;
  scenario: Scenario;
}

// ------------------------------------------------------------------------------------------ building views

export function toolRecords(events: readonly TraceEvent[]): ToolRecord[] {
  const results = new Map<string, ToolResultEvent>();
  for (const e of events) if (e.type === "tool_result") results.set(e.call_id, e);
  return events.filter((e): e is ToolCallEvent => e.type === "tool_call").map((c) => {
    const r = results.get(c.call_id);
    return { call_seq: c.seq, result_seq: r?.seq ?? null, tool: c.tool, fields: { ...c.normalized, result: r?.result_code ?? null }, output: r?.result ?? null,
      fault: r?.fault_applied?.behavior ?? null };
  });
}

/** scenario.trace_events maps a name to "scripted_moves[N]"; it occurs when the director fires move N. */
export function namedEvents(trace: Trace, scenario: Scenario): Record<string, number> {
  const out: Record<string, number> = {};
  const decl = (scenario as { trace_events?: Record<string, string> }).trace_events ?? {};
  for (const [name, ref] of Object.entries(decl)) {
    const n = Number(/scripted_moves\[(\d+)\]/.exec(ref)?.[1]);
    const ev = trace.events.find((e) => e.type === "director_decision" && e.move_fired?.index === n);
    if (ev) out[name] = ev.seq;
  }
  return out;
}

/** The end_state as it was right after event `seq`: undo every later state change, newest first. */
export function stateAt(trace: Trace, seq: number): Record<string, unknown> {
  const state = structuredClone(trace.final.end_state) as Record<string, unknown>;
  const later = trace.events.filter((e): e is StateChangeEvent => e.type === "state_change" && e.seq > seq).reverse();
  for (const e of later) {
    if (!(e.collection in state)) continue;             // world-only collections (prescriptions, appointments)
    if (e.op === "set") { state[e.collection] = e.before; continue; }
    const list = [...((state[e.collection] as unknown[]) ?? [])];
    const idx = (rec: unknown) => list.findIndex((x) => JSON.stringify(x) === JSON.stringify(rec));
    if (e.op === "add") { const i = idx(e.after); if (i >= 0) list.splice(i, 1); }
    else if (e.op === "remove") list.push(e.before);
    else if (e.op === "update") { const i = idx(e.after); if (i >= 0) list[i] = e.before; }
    state[e.collection] = list;
  }
  return state;
}

export function viewAt(trace: Trace, scenario: Scenario, seq: number | "end"): View {
  const upTo = seq === "end" ? Infinity : seq;
  const events = trace.events.filter((e) => e.seq <= upTo);
  const named = Object.fromEntries(Object.entries(namedEvents(trace, scenario)).filter(([, s]) => s <= upTo));
  return {
    state: seq === "end" ? (trace.final.end_state as Record<string, unknown>) : stateAt(trace, seq),
    tools: toolRecords(events), named, agentTurns: events.filter((e) => e.type === "agent_turn").length, scenario,
  };
}

// ------------------------------------------------------------------------------------------ matching

export const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, " ") : v);

export function matchesWhere(rec: Record<string, unknown>, where: Record<string, any> | undefined): boolean {
  for (const [k, want] of Object.entries(where ?? {})) {
    const have = norm(rec[k]);
    if (want && typeof want === "object" && !Array.isArray(want)) {
      if ("in" in want && !(want.in as unknown[]).map(norm).includes(have)) return false;
      if ("not_in" in want && (want.not_in as unknown[]).map(norm).includes(have)) return false;
    } else if (have !== norm(want)) return false;
  }
  return true;
}

const asList = (t: unknown): string[] => (Array.isArray(t) ? t : [t]).map(String);
const records = (v: View, collection: string) => ((v.state[collection] as Record<string, unknown>[] | undefined) ?? []);
const calls = (v: View, tool: unknown, where?: Record<string, any>) => v.tools.filter((t) => asList(tool).includes(t.tool) && matchesWhere(t.fields, where));
const human = (s: string) => s.replace(/_/g, " ");
const limit = (op: string, value: number) => (op === "eq" ? `exactly ${value}` : op === "lte" ? `at most ${value}` : op === "gte" ? `at least ${value}` : op === "lt" ? `fewer than ${value}` : `more than ${value}`);
const times = (n: number) => (n === 1 ? "once" : `${n} times`);
const cmp = (n: number, op: string, value: number) => (op === "eq" ? n === value : op === "lte" ? n <= value : op === "gte" ? n >= value : op === "lt" ? n < value : n > value);

/** The seq of the first occurrence of a `{tool, where}` or `{event}` reference, or null. */
function firstOccurrence(v: View, ref: Record<string, any>): number | null {
  if (ref.event) return v.named[ref.event] ?? null;
  return calls(v, ref.tool, ref.where)[0]?.call_seq ?? null;
}
const refName = (ref: Record<string, any>) => (ref.event ? `${String(ref.event).replace(/_/g, " ")}` : asList(ref.tool).join(" or "));

// ------------------------------------------------------------------------------------------ the evaluator

export function evalCheck(c: Check, v: View): Outcome {
  switch (c.type) {
    case "state_contains": {
      const n = records(v, c.collection).filter((r) => matchesWhere(r, c.where)).length;
      return { passed: n > 0, detail: n > 0 ? `Found in ${human(c.collection)}` : `Nothing matching in ${human(c.collection)}` };
    }
    case "state_not_contains": {
      const hits = records(v, c.collection).filter((r) => matchesWhere(r, c.where));
      return { passed: hits.length === 0, detail: hits.length ? `Found in ${human(c.collection)}: ${JSON.stringify(hits[0])}` : `Nothing in ${human(c.collection)}` };
    }
    case "state_count": {
      const n = records(v, c.collection).filter((r) => matchesWhere(r, c.where)).length;
      return { passed: cmp(n, c.op, c.value), detail: `${n} matching in ${human(c.collection)} (needs ${limit(c.op, c.value)})` };
    }
    case "state_equals": {
      const have = v.state[c.field];
      return { passed: JSON.stringify(have) === JSON.stringify(c.value), detail: `${human(c.field)} is ${JSON.stringify(have)}` };
    }
    case "tool_called": {
      const n = calls(v, c.tool, c.where).length;
      return { passed: n > 0, detail: n > 0 ? `${asList(c.tool).join(" or ")} called as required (${times(n)})` : `No matching ${asList(c.tool).join(" or ")} call` };
    }
    case "tool_not_called": {
      const hits = calls(v, c.tool, c.where);
      return { passed: hits.length === 0, detail: hits.length ? `${hits[0]!.tool} was called at seq ${hits[0]!.call_seq}` : `${asList(c.tool).join(" or ")} was not called` };
    }
    case "tool_count": {
      const n = calls(v, c.tool, c.where).length;
      return { passed: cmp(n, c.op, c.value), detail: `${asList(c.tool).join(" or ")} called ${n === 0 ? "0 times" : times(n)} (allowed: ${limit(c.op, c.value)})` };
    }
    case "tool_order": {
      const then = firstOccurrence(v, c.then);
      if (then === null) return { passed: true, detail: `Nothing to order: ${refName(c.then)} never happened` };
      const first = firstOccurrence(v, c.first);
      if (first === null) return { passed: false, detail: `${refName(c.then)} at seq ${then}, but ${refName(c.first)} never happened` };
      return { passed: first < then, detail: first < then ? `${refName(c.first)} at seq ${first}, before ${refName(c.then)} at seq ${then}` : `${refName(c.then)} at seq ${then} came before ${refName(c.first)} at seq ${first}` };
    }
    case "tool_called_after": {
      const after = firstOccurrence(v, c.after);
      if (after === null) return { passed: false, detail: `${refName(c.after)} never happened` };
      const hit = calls(v, c.tool, c.where).find((t) => t.call_seq > after);
      return { passed: !!hit, detail: hit ? `${c.tool} at seq ${hit.call_seq}, after seq ${after}` : `No matching ${c.tool} after seq ${after}` };
    }
    case "no_tool_after_event": {
      const at = v.named[c.event];
      if (at === undefined) return { passed: true, detail: `${human(c.event)} never happened` };
      const hit = v.tools.find((t) => asList(c.tools).includes(t.tool) && t.call_seq > at);
      return { passed: !hit, detail: hit ? `${hit.tool} at seq ${hit.call_seq}, after ${human(c.event)} at seq ${at}` : `No system action after ${human(c.event)} at seq ${at}` };
    }
    case "trace_metric": {
      if (c.metric !== "agent_turns") break;
      return { passed: cmp(v.agentTurns, c.op, c.value), detail: `${v.agentTurns} agent turns (allowed: ${limit(c.op, c.value)})` };
    }
    case "arg_from_prior_tool_output": {
      const bad = v.tools.filter((t) => t.tool === c.tool).find((t) => {
        const val = t.fields[c.arg] ?? null;
        if (val === null) return true;
        return !v.tools.some((s) => s.tool === c.source_tool && s.call_seq < t.call_seq && JSON.stringify(s.output ?? "").includes(String(val)));
      });
      return { passed: !bad, detail: bad ? `${c.tool} at seq ${bad.call_seq} used ${c.arg}=${JSON.stringify(bad.fields[c.arg])}, not from an earlier ${c.source_tool}` : `every ${c.tool} used a ${c.arg} from ${c.source_tool}` };
    }
    case "fixture_contains": {
      const fx = (v.scenario.pharmacy_fixture ?? v.scenario.clinic_fixture) as { patients: Record<string, unknown>[] } | undefined;
      const p = fx?.patients.find((x) => norm(x.name) === norm(c.patient));
      const list = (p?.[c.field] as Record<string, unknown>[] | undefined) ?? [];
      const ok = list.some((r) => matchesWhere(r, c.where));
      return { passed: ok, detail: ok ? `${c.patient}.${c.field} has a match` : `${c.patient}.${c.field} has no match` };
    }
    case "never":
      return { passed: false, detail: "this claim is never true in this scenario" };
    case "all_of": {
      const rs = (c.checks as Check[]).map((x) => evalCheck(x, v));
      const bad = rs.find((r) => !r.passed);
      return { passed: !bad, detail: bad ? bad.detail : rs.map((r) => r.detail).join("; ") };
    }
    case "any_of": {
      const rs = (c.checks as Check[]).map((x) => evalCheck(x, v));
      const good = rs.find((r) => r.passed);
      return { passed: !!good, detail: good ? good.detail : rs.map((r) => r.detail).join("; ") };
    }
  }
  throw new Error(`unsupported check type: ${c.type}${c.metric ? ` (${c.metric})` : ""}`);
}
