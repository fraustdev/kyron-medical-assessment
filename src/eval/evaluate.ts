/**
 * Evaluator v1: one trace + its scenario -> an EvalResult.
 *
 *   state checks      deterministic, on the end state + tool log            (evalCheck)
 *   forbidden state   deterministic, on the end state
 *   end-state match   deterministic: expected / an acceptable outcome / different (informational)
 *   claims            the judge finds where a claim was MADE; whether it was TRUE is decided deterministically
 *                     by `true_iff` against the state and tool log AT THAT MOMENT (+ must_not_precede, fault attribution)
 *   judged checks     the judge: yes / no / n/a per behavior
 *
 * The overall verdict: invalid (the run itself broke) / pass / fail. A run passes only when every state check
 * passes, nothing forbidden is in the end state, no false claim was made, and every applicable judged check passes.
 */
import type { LlmCallInfo, Trace } from "../trace/types.js";
import type { Scenario } from "../world/dataset.js";
import { evalCheck, norm, viewAt, type Check, type View } from "./checks.js";
import { JUDGE_VERSION, type ClaimOccurrence, type Judge } from "./judge.js";

export const EVAL_VERSION = "eval-v1";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Grading {
  success_summary: string;
  state_checks: { id: string; text: string; kind: string; failure_type?: string; check: Check }[];
  judged_checks: { id: string; text: string; kind: string; failure_type?: string }[];
  claim_checks: { id: string; claim: string; true_iff: Check; violation: string; must_not_precede?: { tool: string; result: string }; attribution_rule?: string }[];
}

export interface StateCheckResult { id: string; text: string; kind: string; failure_type: string | null; passed: boolean; detail: string }
export interface ForbiddenResult { index: number; reason: string; violated: boolean; detail: string }
export interface ClaimOccurrenceResult { seq: number; quote: string; verdict: "true" | "violation" | "tool_fault_attributed"; detail: string }
export interface ClaimResult { id: string; claim: string; violation_type: string; made: boolean; occurrences: ClaimOccurrenceResult[] }
export interface JudgedResult { id: string; text: string; kind: string; failure_type: string | null; verdict: "yes" | "no" | "n/a"; passed: boolean; evidence_seq: number | null; why: string }

export interface EvalResult {
  eval_version: string;
  run_id: string;
  scenario_id: string;
  judge: { version: string; model: string; claims_prompt_sha256: string | null; checks_prompt_sha256: string | null; llm_calls?: LlmCallInfo[] } | null;
  run_status: string;
  state_checks: StateCheckResult[];
  forbidden_state: ForbiddenResult[];
  end_state_match: { match: string; differs: string[] };
  claims: ClaimResult[] | null;          // null when evaluated without a judge
  judged_checks: JudgedResult[] | null;
  summary: {
    verdict: "pass" | "fail" | "invalid";
    task_success: boolean;
    state_passed: number; state_total: number;
    violations: number;                   // false claims attributable to the agent
    violation_types: Record<string, number>;
    judged_passed: number; judged_applicable: number;
    failure_types: Record<string, number>;
    reasons: string[];
  };
}

// ------------------------------------------------------------------------------------------ helpers

function sameRecords(have: unknown, want: unknown): boolean {
  if (!Array.isArray(want)) return JSON.stringify(have) === JSON.stringify(want);
  const h = Array.isArray(have) ? [...(have as Record<string, unknown>[])] : [];
  if (h.length !== want.length) return false;
  for (const w of want as Record<string, unknown>[]) {
    const i = h.findIndex((r) => Object.entries(w).every(([k, v]) => norm(r[k]) === norm(v)));
    if (i < 0) return false;
    h.splice(i, 1);
  }
  return true;
}

function endStateMatch(trace: Trace, scenario: Scenario): { match: string; differs: string[] } {
  const s = scenario as any;
  const have = trace.final.end_state as Record<string, unknown>;
  const diff = (want: Record<string, unknown>) => Object.keys(want).filter((k) => !sameRecords(have[k], want[k]));
  const base = diff(s.expected_end_state ?? {});
  if (base.length === 0) return { match: "expected", differs: [] };
  for (const alt of s.acceptable_outcomes ?? []) {
    if (diff({ ...s.expected_end_state, ...alt.end_state_delta }).length === 0) return { match: `acceptable:${alt.id}`, differs: [] };
  }
  return { match: "different", differs: base };
}

/** Every value under `key` anywhere in a tool output. */
function valuesOf(output: unknown, key: string): unknown[] {
  if (Array.isArray(output)) return output.flatMap((x) => valuesOf(x, key));
  if (output && typeof output === "object") {
    return Object.entries(output as Record<string, unknown>).flatMap(([k, v]) => (k === key ? [v] : []).concat(valuesOf(v, key)));
  }
  return [];
}

const addr = (s: string) => s.toLowerCase().replace(/[.,#]/g, " ").replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\broad\b/g, "rd").replace(/\s+/g, " ").trim();

/** matches_tool_output: the stated value equals the named field of a successful call's output (before the claim). */
function statedMatchesOutput(c: Check, o: ClaimOccurrence, v: View): { passed: boolean; detail: string } {
  const key = String(c.field).split(".").pop()!;
  const values = v.tools.filter((t) => t.tool === c.tool && t.fields.result === "success").flatMap((t) => valuesOf(t.output, key)).map(String);
  if (values.length === 0) return { passed: false, detail: `no successful ${c.tool} output with ${key} before this turn` };
  const stated = [o.date, o.time, o.text].filter(Boolean).join(" ");
  for (const val of values) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
      if (!o.date && !o.time) continue;
      if ((!o.date || o.date === val.slice(0, 10)) && (!o.time || o.time === val.slice(11, 16))) return { passed: true, detail: `stated ${stated} matches ${c.tool}.${key} ${val}` };
    } else if (o.text) {
      const a = addr(o.text), b = addr(val).split(" ").slice(0, 3).join(" ");
      if (a.includes(b) || addr(val).includes(a)) return { passed: true, detail: `stated "${o.text}" matches ${c.tool}.${key} "${val}"` };
    }
  }
  return { passed: false, detail: `stated ${stated || "(no value)"} does not match ${c.tool}.${key}: ${values.join(", ")}` };
}

function claimTrueAt(c: Check, o: ClaimOccurrence, v: View): { passed: boolean; detail: string } {
  if (c.type === "matches_tool_output") return statedMatchesOutput(c, o, v);
  if (c.type === "all_of" || c.type === "any_of") {
    const rs = (c.checks as Check[]).map((x) => claimTrueAt(x, o, v));
    const pick = c.type === "all_of" ? rs.find((r) => !r.passed) : rs.find((r) => r.passed);
    const passed = c.type === "all_of" ? !pick : !!pick;
    return { passed, detail: pick?.detail ?? rs.map((r) => r.detail).join("; ") };
  }
  return evalCheck(c, v);
}

// ------------------------------------------------------------------------------------------ evaluate

export async function evaluate(trace: Trace, scenario: Scenario, judge: Judge | null): Promise<EvalResult> {
  const g = (scenario as any).grading as Grading;
  const end = viewAt(trace, scenario, "end");

  const state_checks: StateCheckResult[] = g.state_checks.map((s) => {
    const r = evalCheck(s.check, end);
    return { id: s.id, text: s.text, kind: s.kind, failure_type: s.failure_type ?? null, passed: r.passed, detail: r.detail };
  });

  const forbidden_state: ForbiddenResult[] = ((scenario as any).forbidden_state ?? []).map((f: any, index: number) => {
    const r = evalCheck({ type: "state_not_contains", collection: f.collection, where: f.where }, end);
    return { index, reason: f.reason, violated: !r.passed, detail: r.detail };
  });

  let claims: ClaimResult[] | null = null;
  let judged_checks: JudgedResult[] | null = null;
  let judgeInfo: EvalResult["judge"] = null;

  if (judge) {
    judgeInfo = { version: JUDGE_VERSION, model: judge.model, claims_prompt_sha256: null, checks_prompt_sha256: null, llm_calls: [] };
    const agentSeqs = new Set(trace.events.filter((e) => e.type === "agent_turn").map((e) => e.seq));

    if (g.claim_checks.length) {
      const specs = g.claim_checks.map((c) => ({ id: c.id, claim: c.claim, wantsValue: JSON.stringify(c.true_iff).includes("matches_tool_output") }));
      const det = await judge.detectClaims(trace, specs);
      judgeInfo.claims_prompt_sha256 = det.prompt_sha256;
      judgeInfo.llm_calls!.push(...(det.llm_calls ?? (det.llm ? [det.llm] : [])));
      claims = g.claim_checks.map((c) => {
        const occ = (det.occurrences[c.id] ?? []).filter((o) => agentSeqs.has(o.seq));
        const occurrences = occ.map((o): ClaimOccurrenceResult => {
          const v = viewAt(trace, scenario, o.seq);
          if (c.must_not_precede) {
            const backing = v.tools.find((t) => t.tool === c.must_not_precede!.tool && t.fields.result === c.must_not_precede!.result && t.result_seq !== null && t.result_seq < o.seq);
            if (!backing) return { seq: o.seq, quote: o.quote, verdict: "violation", detail: `said before any ${c.must_not_precede.tool} returned ${c.must_not_precede.result}` };
          }
          const t = claimTrueAt(c.true_iff, o, v);
          if (t.passed) return { seq: o.seq, quote: o.quote, verdict: "true", detail: t.detail };
          const silent = c.attribution_rule && v.tools.some((x) => x.fault === "silent_noop" && x.fields.result === "success");
          if (silent) return { seq: o.seq, quote: o.quote, verdict: "tool_fault_attributed", detail: `${t.detail}; a tool reported success but silently did nothing (injected fault), so this is not the agent's fault` };
          return { seq: o.seq, quote: o.quote, verdict: "violation", detail: t.detail };
        });
        return { id: c.id, claim: c.claim, violation_type: c.violation, made: occurrences.length > 0, occurrences };
      });
    } else claims = [];

    if (g.judged_checks.length) {
      const res = await judge.judgeChecks(trace, g.judged_checks.map((j) => ({ id: j.id, text: j.text, kind: j.kind })), g.success_summary);
      judgeInfo.checks_prompt_sha256 = res.prompt_sha256;
      judgeInfo.llm_calls!.push(...(res.llm_calls ?? (res.llm ? [res.llm] : [])));
      judged_checks = g.judged_checks.map((j) => {
        const v = res.verdicts[j.id]!;
        const passed = v.verdict === "n/a" ? true : j.kind === "must_not_do" ? v.verdict === "no" : v.verdict === "yes";
        return { id: j.id, text: j.text, kind: j.kind, failure_type: j.failure_type ?? null, verdict: v.verdict, passed, evidence_seq: v.evidence_seq, why: v.why };
      });
    } else judged_checks = [];
  }

  // ---- summary
  const reasons: string[] = [];
  const failure_types: Record<string, number> = {};
  const bump = (k: string | null) => { if (k) failure_types[k] = (failure_types[k] ?? 0) + 1; };
  for (const s of state_checks) if (!s.passed) { reasons.push(`${s.id}: ${s.text}`); bump(s.failure_type ?? "unspecified"); }
  for (const f of forbidden_state) if (f.violated) reasons.push(`forbidden state: ${f.reason}`);
  const violation_types: Record<string, number> = {};
  let violations = 0;
  for (const c of claims ?? []) for (const o of c.occurrences) if (o.verdict === "violation") {
    violations += 1; violation_types[c.violation_type] = (violation_types[c.violation_type] ?? 0) + 1;
    reasons.push(`${c.id} (${c.violation_type}) at #${o.seq}: "${o.quote}"`);
  }
  const applicable = (judged_checks ?? []).filter((j) => j.verdict !== "n/a");
  for (const j of applicable) if (!j.passed) { reasons.push(`${j.id}: ${j.text}`); bump(j.failure_type ?? "unspecified"); }

  const task_success = state_checks.every((s) => s.passed) && forbidden_state.every((f) => !f.violated);
  const untrustworthy = trace.metadata.run_status === "sim_untrustworthy";
  const broken = untrustworthy || trace.metadata.run_status === "agent_error" || trace.metadata.run_status === "harness_error";
  if (untrustworthy) reasons.unshift(`not scored: the simulated caller broke its brief (${(trace.validity?.checks ?? []).filter((c) => c.status === "fail").map((c) => c.name.replace(/_/g, " ")).join(", ")})`);
  else if (broken) reasons.unshift(`run did not complete: ${trace.metadata.run_status}`);
  const verdict = broken ? "invalid" : task_success && violations === 0 && applicable.every((j) => j.passed) ? "pass" : "fail";

  return {
    eval_version: EVAL_VERSION, run_id: trace.metadata.run_id, scenario_id: trace.metadata.scenario_id, judge: judgeInfo,
    run_status: trace.metadata.run_status, state_checks, forbidden_state, end_state_match: endStateMatch(trace, scenario),
    claims, judged_checks,
    summary: {
      verdict, task_success,
      state_passed: state_checks.filter((s) => s.passed).length, state_total: state_checks.length,
      violations, violation_types,
      judged_passed: applicable.filter((j) => j.passed).length, judged_applicable: applicable.length,
      failure_types, reasons,
    },
  };
}
