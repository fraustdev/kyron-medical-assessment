/**
 * The app's queries: plain functions over the Db, so they are tested without HTTP.
 *
 * Review model: every evaluated item (a state check, a claim, a judged check, and the run as a whole) has an
 * AUTO result from the evaluator and, optionally, a HUMAN label (passed / failed + note). The human label
 * overrides the auto result wherever results are shown ("effective"), and calibration compares the two.
 */
import type { ClaimResult, EvalResult } from "../eval/evaluate.js";
import type { Trace } from "../trace/types.js";
import type { Db, Label } from "./db.js";

export type ItemSource = "state" | "claim" | "judged" | "run";
export interface ReviewItem { item_id: string; source: ItemSource; text: string; kind: string | null; failure_type: string | null; auto_passed: boolean; human: Label | null }

interface RunRow {
  run_id: string; batch: string; scenario_id: string; dataset: string; title: string | null; category: string | null; tags: string;
  agent_id: string; agent_version: string; agent_model: string | null; caller_type: string; caller_model: string | null;
  run_status: string; mode: string; trial_index: number; started_at: string; turns: number; tool_calls: number;
  verdict: string | null; state_passed: number | null; state_total: number | null; violations: number | null;
  judged_passed: number | null; judged_applicable: number | null; trace_path: string; trace_json: string; eval_json: string | null;
}

const claimPassed = (c: ClaimResult) => c.occurrences.every((o) => o.verdict !== "violation");

// ------------------------------------------------------------------------------------------ the story of a call

/**
 * A plain-English account of one call, built only from the recording and the answer key (no LLM):
 * what the test is, what should happen, what actually happened, and which scripted moments the call reached.
 */
export interface Checkpoint { index: number; say: string; trigger: string; reached: boolean; turn: number | null }
export interface Story { test: string; catch: string | null; should: string; happened: string[]; checkpoints: Checkpoint[] | null }

const RECORD_WORDS: Record<string, [string, string]> = {
  refills_queued: ["refill queued", "refills queued"],
  renewal_requests: ["renewal request sent to a prescriber", "renewal requests sent to prescribers"],
  new_rx_requests: ["new-prescription request", "new-prescription requests"],
  transfers: ["transfer recorded", "transfers recorded"],
  default_store_changes: ["default-store change", "default-store changes"],
  caregiver_auth_requests: ["caregiver authorization request", "caregiver authorization requests"],
  pharmacist_callbacks: ["pharmacist callback", "pharmacist callbacks"],
  bookings: ["appointment booked", "appointments booked"],
  cancellations: ["appointment cancelled", "appointments cancelled"],
  waitlist_entries: ["waitlist entry", "waitlist entries"],
  callbacks: ["callback request", "callback requests"],
  nurse_line_transfers: ["transfer to the nurse line", "transfers to the nurse line"],
};
const END_WORDS: Record<string, string> = {
  stop_condition: "The caller ended the call.",
  emergency_instruction: "The caller hung up to call 911.",
  transfer: "The agent transferred the call.",
  turn_cap: "The call ran out of turns without finishing.",
  agent_hangup: "The agent ended the call.",
};

const CATEGORY: Record<string, string> = {
  control: "A control: a routine call that any competent agent should pass. It checks the agent isn't broken or over-cautious.",
  ordinary: "An everyday call with no tricks.",
  hard: "A hard case, built to trip the agent up.",
  fault: "A fault test: one of the pharmacy systems is made to fail on purpose, to see whether the agent is honest about it.",
};
const TAG: Record<string, string> = {
  caregiver: "someone is calling on the patient's behalf",
  buried_symptom: "a medical emergency is mentioned in passing",
  controlled_substance: "a controlled substance with stricter rules",
  mid_call_correction: "the caller corrects themselves mid-call",
  zero_refills: "the prescription has no refills left",
  ambiguous_pharmacy: "it's unclear which pharmacy the caller means",
  identity_failure: "the caller can't be verified",
  out_of_scope: "the caller asks for something the agent can't do",
  caller_pacing: "the caller's pace (slow, hurried or hanging up early)",
  ambiguous_date: "an ambiguous date",
  ambiguous_appointment: "it's unclear which appointment is meant",
  no_availability: "no appointment is available",
  cross_workflow: "the request spans pharmacy and clinic",
};
function catchFor(category: string, tags: string[]): string | null {
  const base = CATEGORY[category] ?? null;
  const parts = tags.map((t) => TAG[t] ?? t.replace(/_/g, " "));
  if (!parts.length) return base;
  return `${base ?? ""} What makes it hard: ${parts.join("; ")}.`.trim();
}

const lowerFirst = (t: string) => (t ? t[0]!.toLowerCase() + t.slice(1) : t);

export function callStory(trace: Trace, ev: EvalResult | null, scenario: Record<string, unknown> | null): Story {
  const caller = (scenario?.caller ?? {}) as Record<string, unknown>;
  const role = String(caller.role ?? "caller").replace(/_/g, " ");
  const goal = String(caller.goal ?? "").replace(/\.$/, "");
  const test = `${String(caller.name ?? "The caller")} (${role}) calls to ${lowerFirst(goal)}.`;
  const catchText = catchFor(String(scenario?.category ?? ""), (scenario?.hard_case_tags as string[] | undefined) ?? []);
  const should = String((scenario?.grading as { success_summary?: string } | undefined)?.success_summary ?? "");

  // What happened, from the records and the log.
  const happened: string[] = [];
  const end = trace.final.end_state as Record<string, unknown>;
  const tools = trace.events.filter((e) => e.type === "tool_call").length;
  happened.push(end.identity_verified ? "The agent verified the caller's identity." : "The agent never verified the caller's identity.");
  const changes = Object.entries(RECORD_WORDS).flatMap(([k, [one, many]]) => {
    const n = Array.isArray(end[k]) ? (end[k] as unknown[]).length : 0;
    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  });
  happened.push(changes.length ? `Records changed: ${changes.join(", ")}.` : `No records were changed${tools ? ` (the agent looked things up ${tools} time${tools === 1 ? "" : "s"} but did not act)` : ""}.`);
  const faults = trace.events.filter((e) => e.type === "tool_result" && e.fault_applied);
  if (faults.length) happened.push(`The test injected ${faults.length === 1 ? "a system fault" : `${faults.length} system faults`} to see how the agent copes.`);
  if (ev) {
    const missed = ev.state_checks.filter((c) => !c.passed);
    if (missed.length) happened.push(`Missed: ${missed.slice(0, 3).map((c) => lowerFirst(c.text.replace(/\.$/, ""))).join("; ")}${missed.length > 3 ? `; and ${missed.length - 3} more` : ""}.`);
    if (ev.summary.violations) happened.push(`The agent said something was done when it wasn't (${ev.summary.violations} time${ev.summary.violations === 1 ? "" : "s"}).`);
  }
  const endEv = trace.events.find((e) => e.type === "call_end");
  if (endEv?.type === "call_end") happened.push(END_WORDS[endEv.reason] ?? `The call ended (${endEv.reason}).`);
  if (trace.metadata.run_status === "agent_error" || trace.metadata.run_status === "harness_error") happened.push("The run broke before the call finished, so it isn't scored.");

  // Checkpoints: the scripted moments, and whether the call got that far.
  let checkpoints: Checkpoint[] | null = null;
  const moves = (scenario?.scripted_moves as { trigger: string; say: string }[] | undefined) ?? [];
  if (trace.metadata.caller.type === "simulated" && moves.length) {
    checkpoints = moves.map((m, i) => {
      const fired = trace.events.find((e) => e.type === "director_decision" && e.move_fired?.index === i);
      return { index: i, say: m.say, trigger: m.trigger.split(/;\s*fire anyway/i)[0]!.trim(), reached: !!fired, turn: fired ? fired.turn + 1 : null };
    });
  }
  return { test, catch: catchText, should, happened, checkpoints };
}

// ------------------------------------------------------------------------------------------ call strip

/** The whole call as a compact sequence, for the "call strip" drawn on every run. */
export interface StripItem { seq: number; kind: "caller" | "agent" | "tool"; turn: number; ok?: boolean; fault?: boolean }
export interface Strip { items: StripItem[]; problems: number[]; end: string | null }

/** Where the evaluation points at a problem: false claims, failed judged behaviors, and failed checks citing a seq. */
export function problemSeqs(ev: EvalResult | null, labels: Label[] = []): number[] {
  if (!ev) return [];
  const passedByHuman = (id: string) => labels.find((l) => l.item_id === id)?.human_passed === true;
  const out = new Set<number>();
  for (const c of ev.claims ?? []) if (!passedByHuman(c.id)) for (const o of c.occurrences) if (o.verdict === "violation") out.add(o.seq);
  for (const j of ev.judged_checks ?? []) if (!j.passed && j.evidence_seq !== null && !passedByHuman(j.id)) out.add(j.evidence_seq);
  for (const s of ev.state_checks) if (!s.passed && !passedByHuman(s.id)) for (const m of s.detail.matchAll(/seq (\d+)/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

export function callStrip(trace: Trace, ev: EvalResult | null, labels: Label[] = []): Strip {
  const results = new Map(trace.events.flatMap((e) => (e.type === "tool_result" ? [[e.call_id, e] as const] : [])));
  const items: StripItem[] = trace.events.flatMap((e): StripItem[] => {
    if (e.type === "caller_turn") return [{ seq: e.seq, kind: "caller", turn: e.turn }];
    if (e.type === "agent_turn") return [{ seq: e.seq, kind: "agent", turn: e.turn }];
    if (e.type === "tool_call") {
      const r = results.get(e.call_id);
      return [{ seq: e.seq, kind: "tool", turn: e.turn, ok: r?.result_code === "success", fault: !!r?.fault_applied }];
    }
    return [];
  });
  // A problem cited on a tool RESULT is drawn on its call.
  const callOf = new Map(trace.events.flatMap((e) => (e.type === "tool_result" ? [[e.seq, trace.events.find((c) => c.type === "tool_call" && c.call_id === e.call_id)?.seq ?? e.seq] as const] : [])));
  const problems = [...new Set(problemSeqs(ev, labels).map((s) => callOf.get(s) ?? s))];
  const end = trace.events.find((e) => e.type === "call_end");
  return { items, problems, end: end?.type === "call_end" ? end.reason : null };
}

export function reviewItems(ev: EvalResult, labels: Label[]): ReviewItem[] {
  const human = (id: string) => labels.find((l) => l.item_id === id) ?? null;
  const items: ReviewItem[] = [
    { item_id: "run", source: "run", text: "Overall verdict", kind: null, failure_type: null, auto_passed: ev.summary.verdict === "pass", human: human("run") },
    ...ev.state_checks.map((s): ReviewItem => ({ item_id: s.id, source: "state", text: s.text, kind: s.kind, failure_type: s.failure_type, auto_passed: s.passed, human: human(s.id) })),
    ...(ev.claims ?? []).map((c): ReviewItem => ({ item_id: c.id, source: "claim", text: c.claim, kind: c.violation_type, failure_type: null, auto_passed: claimPassed(c), human: human(c.id) })),
    ...(ev.judged_checks ?? []).map((j): ReviewItem => ({ item_id: j.id, source: "judged", text: j.text, kind: j.kind, failure_type: j.failure_type, auto_passed: j.passed, human: human(j.id) })),
  ];
  return items;
}

/** The verdict shown in the app: the human's run-level label if there is one, else the evaluator's. */
function effectiveVerdict(r: RunRow, labels: Label[]): string | null {
  const h = labels.find((l) => l.run_id === r.run_id && l.item_id === "run");
  if (h) return h.human_passed ? "pass" : "fail";
  return r.verdict;
}

// ------------------------------------------------------------------------------------------ runs

export function listRuns(db: Db, q: { batch?: string; verdict?: string; scenario?: string } = {}) {
  const rows = db.db.prepare(`SELECT * FROM runs ORDER BY batch, scenario_id, trial_index`).all() as unknown as RunRow[];
  const labels = db.labels();
  return rows
    .filter((r) => (!q.batch || r.batch === q.batch) && (!q.scenario || r.scenario_id === q.scenario))
    .map((r) => {
      const { trace_json: _t, eval_json: _e, ...rest } = r;
      const own = labels.filter((l) => l.run_id === r.run_id);
      const strip = callStrip(JSON.parse(r.trace_json) as Trace, r.eval_json ? (JSON.parse(r.eval_json) as EvalResult) : null, own);
      return { ...rest, strip, tags: JSON.parse(r.tags) as string[], effective_verdict: effectiveVerdict(r, labels), overridden: own.some((l) => l.item_id === "run"), labels: own.length };
    })
    .filter((r) => !q.verdict || r.effective_verdict === q.verdict || (q.verdict === "unevaluated" && r.verdict === null));
}

export function getRun(db: Db, runId: string) {
  const r = db.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as unknown as RunRow | undefined;
  if (!r) return null;
  const trace = JSON.parse(r.trace_json) as Trace;
  const ev = r.eval_json ? (JSON.parse(r.eval_json) as EvalResult) : null;
  const labels = db.labels(runId);
  const s = db.scenario(r.scenario_id) as Record<string, unknown> | null;
  const scenario = s && {
    id: s.id, title: s.title, category: s.category, hard_case_tags: s.hard_case_tags, caller: s.caller,
    disclosure_rules: s.disclosure_rules, scripted_moves: s.scripted_moves, caller_stop_conditions: s.caller_stop_conditions,
    success_summary: (s.grading as { success_summary?: string } | undefined)?.success_summary ?? null,
    tool_faults: s.tool_faults ?? [],
  };
  return { run: listRuns(db).find((x) => x.run_id === runId)!, trace, eval: ev, scenario, story: callStory(trace, ev, s), review: ev ? reviewItems(ev, labels) : [], labels };
}

// ------------------------------------------------------------------------------------------ batches & compare

export interface BatchStats {
  batch: string; runs: number; evaluated: number; invalid: number;
  pass: number; pass_rate: number | null;
  state_pass_rate: number | null;              // share of state checks passed
  runs_with_false_claims: number; false_claims: number;
  judged_pass_rate: number | null;
  agents: string[]; overridden: number;
}

const rate = (a: number, b: number) => (b > 0 ? a / b : null);

export function batchStats(db: Db, batch: string): BatchStats {
  const runs = listRuns(db, { batch });
  const ev = runs.filter((r) => r.verdict !== null);
  const scored = ev.filter((r) => r.verdict !== "invalid");
  const sum = (f: (r: (typeof runs)[number]) => number | null) => scored.reduce((a, r) => a + (f(r) ?? 0), 0);
  return {
    batch, runs: runs.length, evaluated: ev.length, invalid: ev.length - scored.length,
    pass: scored.filter((r) => r.effective_verdict === "pass").length,
    pass_rate: rate(scored.filter((r) => r.effective_verdict === "pass").length, scored.length),
    state_pass_rate: rate(sum((r) => r.state_passed), sum((r) => r.state_total)),
    runs_with_false_claims: scored.filter((r) => (r.violations ?? 0) > 0).length, false_claims: sum((r) => r.violations),
    judged_pass_rate: rate(sum((r) => r.judged_passed), sum((r) => r.judged_applicable)),
    agents: [...new Set(runs.map((r) => `${r.agent_version} ${r.agent_model ?? "scripted"}`))],
    overridden: runs.filter((r) => r.overridden).length,
  };
}

export function listBatches(db: Db): BatchStats[] {
  const names = (db.db.prepare(`SELECT DISTINCT batch FROM runs ORDER BY batch`).all() as { batch: string }[]).map((r) => r.batch);
  return names.map((b) => batchStats(db, b));
}

export function compare(db: Db, a: string, b: string) {
  const ra = listRuns(db, { batch: a }), rb = listRuns(db, { batch: b });
  const ids = [...new Set([...ra, ...rb].map((r) => r.scenario_id))].sort();
  const side = (rs: typeof ra, id: string) => {
    const mine = rs.filter((r) => r.scenario_id === id && r.verdict !== null && r.verdict !== "invalid");
    if (!mine.length) return null;
    return {
      runs: mine.map((r) => ({ run_id: r.run_id, verdict: r.effective_verdict })),
      pass_rate: mine.filter((r) => r.effective_verdict === "pass").length / mine.length,
      state_pass_rate: rate(mine.reduce((s, r) => s + (r.state_passed ?? 0), 0), mine.reduce((s, r) => s + (r.state_total ?? 0), 0)),
      false_claims: mine.reduce((s, r) => s + (r.violations ?? 0), 0),
    };
  };
  const rows = ids.map((id) => {
    const x = side(ra, id), y = side(rb, id);
    const title = [...ra, ...rb].find((r) => r.scenario_id === id)?.title ?? null;
    const change = !x || !y ? "missing" : y.pass_rate > x.pass_rate ? "improved" : y.pass_rate < x.pass_rate ? "regressed" : "same";
    return { scenario_id: id, title, a: x, b: y, change };
  });
  return { a: batchStats(db, a), b: batchStats(db, b), rows };
}

// ------------------------------------------------------------------------------------------ overview

export function overview(db: Db) {
  const scenarios = db.allScenarios();
  const byDataset: Record<string, { scenarios: number; categories: Record<string, number> }> = {};
  for (const s of scenarios) {
    const d = (byDataset[s._dataset] ??= { scenarios: 0, categories: {} });
    d.scenarios += 1;
    const cat = String((s as { category?: string }).category ?? "other");
    d.categories[cat] = (d.categories[cat] ?? 0) + 1;
  }
  const runs = listRuns(db);
  const latest = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const example = runs.find((r) => r.scenario_id === "S20") ?? runs.find((r) => r.verdict !== null) ?? null;
  const judge = latest ? (getRun(db, latest.run_id)?.eval?.judge?.model ?? null) : null;
  return {
    datasets: byDataset, scenarios: scenarios.length, runs: runs.length, batches: new Set(runs.map((r) => r.batch)).size,
    scored: runs.filter((r) => r.verdict !== null && r.verdict !== "invalid").length,
    models: latest ? { agent: latest.agent_model, caller: latest.caller_model, judge } : null,
    example: example ? { run_id: example.run_id, scenario_id: example.scenario_id, title: example.title } : null,
  };
}

// ------------------------------------------------------------------------------------------ patterns

export function patterns(db: Db, batch?: string) {
  const runs = listRuns(db, batch ? { batch } : {}).filter((r) => r.verdict !== null && r.verdict !== "invalid");
  const byFailureType: Record<string, number> = {};
  const byViolation: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byCategory: Record<string, { runs: number; pass: number }> = {};
  const byTag: Record<string, { runs: number; pass: number }> = {};
  const failedItems: { run_id: string; scenario_id: string; item_id: string; source: string; text: string; failure_type: string | null }[] = [];

  for (const r of runs) {
    const full = getRun(db, r.run_id)!;
    const cat = (byCategory[r.category ?? "?"] ??= { runs: 0, pass: 0 });
    cat.runs += 1; if (r.effective_verdict === "pass") cat.pass += 1;
    for (const t of r.tags) { const x = (byTag[t] ??= { runs: 0, pass: 0 }); x.runs += 1; if (r.effective_verdict === "pass") x.pass += 1; }
    for (const it of full.review) {
      if (it.source === "run") continue;
      const passed = it.human ? it.human.human_passed : it.auto_passed;
      if (passed) continue;
      bySource[it.source] = (bySource[it.source] ?? 0) + 1;
      if (it.failure_type) byFailureType[it.failure_type] = (byFailureType[it.failure_type] ?? 0) + 1;
      if (it.source === "claim" && it.kind) byViolation[it.kind] = (byViolation[it.kind] ?? 0) + 1;
      failedItems.push({ run_id: r.run_id, scenario_id: r.scenario_id, item_id: it.item_id, source: it.source, text: it.text, failure_type: it.failure_type });
    }
  }
  return { runs: runs.length, byFailureType, byViolation, bySource, byCategory, byTag, failedItems };
}

// ------------------------------------------------------------------------------------------ calibration

export function calibration(db: Db) {
  const labels = db.labels();
  const rows: { run_id: string; scenario_id: string; item_id: string; source: ItemSource; text: string; auto_passed: boolean; human_passed: boolean; note: string }[] = [];
  for (const runId of [...new Set(labels.map((l) => l.run_id))]) {
    const full = getRun(db, runId);
    if (!full) continue;
    for (const it of full.review) if (it.human) rows.push({ run_id: runId, scenario_id: full.run.scenario_id, item_id: it.item_id, source: it.source, text: it.text, auto_passed: it.auto_passed, human_passed: it.human.human_passed, note: it.human.note });
  }
  const stats = (rs: typeof rows) => {
    const n = rs.length;
    const tp = rs.filter((r) => r.auto_passed && r.human_passed).length;      // both pass
    const tn = rs.filter((r) => !r.auto_passed && !r.human_passed).length;    // both fail
    const lenient = rs.filter((r) => r.auto_passed && !r.human_passed).length; // evaluator passed what the human failed
    const strict = rs.filter((r) => !r.auto_passed && r.human_passed).length;  // evaluator failed what the human passed
    const po = n ? (tp + tn) / n : null;
    const pe = n ? (((tp + lenient) / n) * ((tp + strict) / n) + ((tn + strict) / n) * ((tn + lenient) / n)) : null;
    const kappa = po !== null && pe !== null && pe < 1 ? (po - pe) / (1 - pe) : null;
    return { n, agree: tp + tn, agreement: po, kappa, both_pass: tp, both_fail: tn, evaluator_too_lenient: lenient, evaluator_too_strict: strict };
  };
  const sources: ItemSource[] = ["judged", "claim", "state", "run"];
  return {
    labeled_runs: new Set(rows.map((r) => r.run_id)).size,
    overall: stats(rows.filter((r) => r.source !== "run")),
    bySource: Object.fromEntries(sources.map((s) => [s, stats(rows.filter((r) => r.source === s))])),
    disagreements: rows.filter((r) => r.auto_passed !== r.human_passed),
  };
}
