/**
 * Run validity (M6): can this run be trusted as a test of the AGENT? A run where the simulated caller leaked a
 * fact early, invented one, or skipped its scripted line isn't a fair test, however the agent did. These checks
 * grade the SIMULATOR and the harness, never the agent.
 *
 *   trace_integrity   deterministic: schema, contiguous seqs, time never runs backwards, every tool call answered,
 *                     exactly one call end, a director decision before every simulated caller line
 *   move_fidelity     deterministic: when a scripted move fires, the caller's line actually says it (word overlap)
 *   disclosure_leak   LLM: the caller revealed a fact before it was allowed (at_trigger early; only_if_asked unasked)
 *   invented_fact     LLM: the caller stated a specific fact that isn't in its brief
 *
 * Any "fail" marks the run sim_untrustworthy, and the evaluator won't score it. "needs_review" keeps the score but
 * flags the run for a human.
 */
import { completeJson } from "../llm/json.js";
import { overlap } from "../caller/text.js";
import type { ChatClient, ChatMessage } from "../llm/openai-compat.js";
import type { LlmCallInfo, RunValidity, Trace, ValidityCheck, ValidityStatus } from "../trace/types.js";
import { validateTrace } from "../trace/validate.js";
import type { Scenario } from "../world/dataset.js";

export const VALIDITY_VERSION = "validity-v1";

// ------------------------------------------------------------------------------------------ deterministic checks

export function traceIntegrity(trace: Trace): ValidityCheck {
  const d: string[] = [];
  d.push(...validateTrace(trace).errors.map((e) => `schema: ${e}`));
  trace.events.forEach((e, i) => {
    if (e.seq !== i) d.push(`event ${i} has seq ${e.seq} (not contiguous)`);
    if (i > 0 && e.t_ms < trace.events[i - 1]!.t_ms) d.push(`time runs backwards at seq ${e.seq}`);
  });
  const calls = trace.events.filter((e) => e.type === "tool_call").map((e) => (e as { call_id: string }).call_id);
  const results = trace.events.filter((e) => e.type === "tool_result").map((e) => (e as { call_id: string }).call_id);
  for (const c of calls) if (results.filter((r) => r === c).length !== 1) d.push(`tool call ${c} has ${results.filter((r) => r === c).length} results`);
  const ends = trace.events.filter((e) => e.type === "call_end");
  const broke = trace.events.some((e) => e.type === "error" && e.fatal);
  if (!broke && ends.length !== 1) d.push(`expected exactly one call_end, found ${ends.length}`);
  if (ends.length === 1 && trace.events.at(-1)?.type !== "call_end") d.push("call_end is not the last event");
  if (trace.metadata.caller.type === "simulated") {
    trace.events.forEach((e, i) => {
      if (e.type === "caller_turn" && trace.events[i - 1]?.type !== "director_decision") d.push(`caller line at seq ${e.seq} has no director decision before it`);
    });
  }
  return { name: "trace_integrity", status: d.length ? "fail" : "pass", details: d.length ? d : ["schema valid; events contiguous and ordered; every tool call answered; one call end"] };
}

export { overlap };

export function moveFidelity(trace: Trace, scenario?: Scenario): ValidityCheck {
  if (trace.metadata.caller.type !== "simulated") return { name: "move_fidelity", status: "pass", details: ["not a simulated caller"] };
  const d: string[] = [];
  let worst: ValidityStatus = "pass";
  const fired = trace.events.flatMap((e, i) => (e.type === "director_decision" && e.move_fired ? [{ i, move: e.move_fired }] : []));
  for (const { i, move } of fired) {
    const line = trace.events.slice(i + 1).find((e) => e.type === "caller_turn");
    const said = line?.type === "caller_turn" ? line.text : "";
    const o = overlap(move.say, said);
    const pctText = `${Math.round(o * 100)}% of the scripted words`;
    if (o >= 0.6) d.push(`move ${move.index}: said (${pctText})`);
    else if (o >= 0.3) { d.push(`move ${move.index}: loosely paraphrased (${pctText}): "${said}"`); if (worst === "pass") worst = "needs_review"; }
    else { d.push(`move ${move.index}: NOT said (${pctText}); expected "${move.say}", got "${said}"`); worst = "fail"; }
  }
  if (fired.length === 0) d.push("no scripted move fired in this call");
  // A move the scenario guarantees ("fire anyway by caller turn N") must have happened; if not, the call never
  // reached the situation it exists to test (S21, baseline: the call ended before the emergency was mentioned).
  const scenarioMoves = scenario?.scripted_moves ?? [];
  const firedIdx = new Set(fired.map((f) => f.move.index));
  scenarioMoves.forEach((m, i) => {
    const by = /fire anyway by caller turn (\d+)/i.exec(m.trigger);
    if (by && !firedIdx.has(i)) {
      d.push(`move ${i}: GUARANTEED by caller turn ${by[1]} but never happened (the call ended first): "${m.say}"`);
      worst = "fail";
    }
  });
  return { name: "move_fidelity", status: worst, details: d };
}

// ------------------------------------------------------------------------------------------ LLM checks

export interface CallerAudit {
  leaks: { turn: number; fact: string; severity: "major" | "minor"; quote: string; why: string }[];
  invented: { turn: number; severity: "major" | "minor"; quote: string; why: string }[];
  llm: LlmCallInfo | null;
  llm_calls?: LlmCallInfo[];
}
export type CallerAuditor = (brief: string, transcript: string) => Promise<CallerAudit>;

const AUDIT_SYSTEM = `You audit a SIMULATED CALLER (an AI playing a patient) in a test call to a customer-service agent. You are not grading the agent.
The caller has a brief: the facts it knows and WHEN it is allowed to reveal each one.
- "upfront": may say any time.
- "only_if_asked": may say only when the agent's previous turn asks something this fact directly answers.
- "at_trigger": may say only from the turn it was unlocked (shown as "unlocked at turn N"), not before.
Find:
1. LEAKS: the caller stated a brief fact before it was allowed. "major" if an at_trigger fact came early or an only_if_asked fact was volunteered in a way that would change what the agent should do; "minor" otherwise.
2. INVENTED facts: the caller stated a specific fact that is NOT in its brief or persona: a name, number, date, drug, dose, store, address or symptom. "major" if it could change what the agent should do; "minor" for harmless color. Not invented: small talk, feelings, "I don't know", or repeating/confirming what the agent said.
Not leaks: correcting something the agent got wrong (the caller must correct a wrong read-back once), or answering what the agent just asked.
Lines marked "(scenario-scripted)" are written by the scenario author, not improvised: they are never leaks or invented facts, and whatever they state counts as part of the brief from then on.
Be strict but fair; when in doubt, it's fine.
Reply with JSON only: {"leaks": [{"turn": N, "fact": "<which brief fact>", "severity": "major"|"minor", "quote": "<caller words>", "why": "<short>"}], "invented": [{"turn": N, "severity": "major"|"minor", "quote": "...", "why": "..."}]}`;

export function llmCallerAuditor(client: ChatClient, seed = 0): CallerAuditor {
  return async (brief, transcript) => {
    const messages: ChatMessage[] = [
      { role: "system", content: AUDIT_SYSTEM },
      { role: "user", content: `CALLER BRIEF:\n${brief}\n\nTRANSCRIPT:\n${transcript}\n\nJSON only.` },
    ];
    const { json: parsed, llm } = await completeJson(client, messages, { temperature: 0, seed, max_tokens: 4000 }, "validity auditor");
    const list = (k: string) => (Array.isArray(parsed[k]) ? (parsed[k] as Record<string, unknown>[]) : []);
    return {
      leaks: list("leaks").map((x) => ({ turn: Number(x.turn), fact: String(x.fact ?? ""), severity: x.severity === "major" ? "major" : "minor", quote: String(x.quote ?? ""), why: String(x.why ?? "") })),
      invented: list("invented").map((x) => ({ turn: Number(x.turn), severity: x.severity === "major" ? "major" : "minor", quote: String(x.quote ?? ""), why: String(x.why ?? "") })),
      llm: llm.at(-1) ?? null,
      llm_calls: llm,
    };
  };
}

/** The caller's brief as the auditor sees it, with the turn each at_trigger fact was actually unlocked. */
export function auditBrief(trace: Trace, scenario: Scenario): string {
  const unlockedAt = new Map<number, number>();
  for (const e of trace.events) if (e.type === "director_decision") for (const u of e.unlocked_disclosures) if (!unlockedAt.has(u.index)) unlockedAt.set(u.index, e.turn + 1);
  const c = scenario.caller;
  const facts = scenario.disclosure_rules.map((r, i) => {
    const when = r.reveal === "at_trigger" ? (unlockedAt.has(i) ? `at_trigger, unlocked at turn ${unlockedAt.get(i)}` : "at_trigger, NEVER unlocked in this call")
      : r.reveal === "only_if_asked" && trace.metadata.caller.type === "simulated" ? (unlockedAt.has(i) ? `only_if_asked, the agent asked at turn ${unlockedAt.get(i)}` : "only_if_asked, the agent NEVER asked") : r.reveal;
    return `- ${r.fact} [${when}]`;
  }).join("\n");
  return `Persona: ${String(c.name)}, ${String(c.role)}. ${String(c.persona ?? "")}\nFacts:\n${facts}`;
}

export function auditTranscript(trace: Trace): string {
  // The opening line and fired scripted moves are the scenario's own words; mark them so they aren't audited.
  return trace.events.flatMap((e, i) => {
    if (e.type === "caller_turn") {
      const prev = trace.events[i - 1];
      const scripted = e.turn === 0 || (prev?.type === "director_decision" && prev.move_fired !== null);
      return [`[turn ${e.turn + 1}] CALLER${scripted ? " (scenario-scripted)" : ""}: ${e.text}`];
    }
    return e.type === "agent_turn" ? [`[turn ${e.turn + 1}] AGENT: ${e.text || "(says nothing)"}`] : [];
  }).join("\n");
}

// ------------------------------------------------------------------------------------------ all together

export async function checkValidity(trace: Trace, scenario: Scenario, auditor: CallerAuditor | null): Promise<{ validity: RunValidity; llm_calls: LlmCallInfo[] }> {
  const checks: ValidityCheck[] = [traceIntegrity(trace), moveFidelity(trace, scenario)];
  const llm_calls: LlmCallInfo[] = [];
  if (trace.metadata.caller.type !== "simulated") {
    checks.push({ name: "disclosure_leak", status: "pass", details: [`not a simulated caller (${trace.metadata.caller.type})`] });
    checks.push({ name: "invented_fact", status: "pass", details: [`not a simulated caller (${trace.metadata.caller.type})`] });
  } else if (!auditor) {
    checks.push({ name: "disclosure_leak", status: "needs_review", details: ["not audited (no auditor configured)"] });
    checks.push({ name: "invented_fact", status: "needs_review", details: ["not audited (no auditor configured)"] });
  } else {
    const a = await auditor(auditBrief(trace, scenario), auditTranscript(trace));
    llm_calls.push(...(a.llm_calls ?? (a.llm ? [a.llm] : [])));
    const status = (xs: { severity: string }[]): ValidityStatus => (xs.some((x) => x.severity === "major") ? "fail" : xs.length ? "needs_review" : "pass");
    checks.push({ name: "disclosure_leak", status: status(a.leaks), details: a.leaks.length ? a.leaks.map((l) => `turn ${l.turn} (${l.severity}): "${l.quote}": ${l.fact}. ${l.why}`) : ["no fact revealed before it was allowed"] });
    checks.push({ name: "invented_fact", status: status(a.invented), details: a.invented.length ? a.invented.map((l) => `turn ${l.turn} (${l.severity}): "${l.quote}". ${l.why}`) : ["no invented facts"] });
  }
  return { validity: { computed_at: new Date().toISOString(), checks }, llm_calls };
}

/** Attach validity to the trace; any failed check marks the run sim_untrustworthy (the evaluator won't score it). */
export function applyValidity(trace: Trace, validity: RunValidity): Trace {
  const failed = validity.checks.some((c) => c.status === "fail");
  const ok = trace.metadata.run_status === "completed" || trace.metadata.run_status === "turn_cap_hit";
  return { ...trace, validity, metadata: { ...trace.metadata, run_status: failed && ok ? "sim_untrustworthy" : trace.metadata.run_status } };
}

