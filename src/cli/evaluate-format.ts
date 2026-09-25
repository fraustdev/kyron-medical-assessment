import type { EvalResult } from "../eval/evaluate.js";

export function formatEval(r: EvalResult): string {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const L: string[] = [];
  L.push(`${r.scenario_id}  ${r.summary.verdict.toUpperCase()}   state ${r.summary.state_passed}/${r.summary.state_total} · false claims ${r.summary.violations} · judged ${r.summary.judged_passed}/${r.summary.judged_applicable} · end state: ${r.end_state_match.match}${r.end_state_match.differs.length ? ` (differs: ${r.end_state_match.differs.join(", ")})` : ""}`);
  L.push("  state checks");
  for (const s of r.state_checks) L.push(`    ${mark(s.passed)} ${s.id} [${s.kind === "must_not_do" ? "must NOT" : "must"}]  ${s.text}\n        ${s.detail}`);
  for (const f of r.forbidden_state) if (f.violated) L.push(`    ✗ FORBIDDEN  ${f.reason}\n        ${f.detail}`);
  if (r.claims) {
    L.push("  claims");
    for (const c of r.claims) {
      if (!c.made) { L.push(`    · ${c.id}  not made: ${c.claim}`); continue; }
      for (const o of c.occurrences) L.push(`    ${o.verdict === "violation" ? "✗" : o.verdict === "true" ? "✓" : "~"} ${c.id} at #${o.seq} [${o.verdict}${o.verdict === "violation" ? `: ${c.violation_type}` : ""}]  "${o.quote}"\n        ${o.detail}`);
    }
  }
  if (r.judged_checks) {
    L.push("  judged checks");
    for (const j of r.judged_checks) L.push(`    ${j.verdict === "n/a" ? "·" : mark(j.passed)} ${j.id} [${j.kind}: ${j.verdict}${j.evidence_seq !== null ? ` #${j.evidence_seq}` : ""}]  ${j.text}\n        ${j.why}`);
  }
  return L.join("\n");
}
