/**
 * Part 3, steps 6–7: after revising the answer keys (dataset 2.1.1), re-grade the calls the author labelled and
 * measure agreement again.
 *
 *   npx tsx scripts/calibration_rerun.ts
 *
 * The labelled calls in runs/baseline-v1 are copied to research/calibration-rerun/ and re-graded there, so the
 * original grades the labels were made against stay untouched. A label is matched to the re-graded finding with
 * the same id and text; findings retired or renumbered by the revision are reported separately.
 */
import "../src/env.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type EvalResult } from "../src/eval/evaluate.js";
import { LlmJudge } from "../src/eval/judge.js";
import { LlmCache } from "../src/llm/cache.js";
import { ChatClient, llmConfigFromEnv } from "../src/llm/openai-compat.js";
import { reviewItems } from "../src/server/api.js";
import type { Label } from "../src/server/db.js";
import type { Trace } from "../src/trace/types.js";
import { getScenario, loadDataset, REPO_ROOT } from "../src/world/dataset.js";

const SRC = join(REPO_ROOT, "runs", "baseline-v1");
const OUT = join(REPO_ROOT, "research", "calibration-rerun");
mkdirSync(OUT, { recursive: true });

const labels = JSON.parse(readFileSync(join(REPO_ROOT, "labels", "labels.json"), "utf8")) as Label[];
const runIds = [...new Set(labels.map((l) => l.run_id))];
const traceFile = (runId: string) => {
  for (const f of JSON.parse(readFileSync(join(SRC, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => `[${l}]`).join("").replace(/\]\[/g, ",")) as { run_id: string; file: string }[])
    if (f.run_id === runId) return join(REPO_ROOT, f.file);
  throw new Error(`no trace for ${runId}`);
};

const judgeClient = new ChatClient(llmConfigFromEnv("JUDGE"), new LlmCache("live"));
type Row = { run: string; scenario: string; item: string; text: string; human: boolean; before: boolean | null; after: boolean | null };
const rows: Row[] = [];

for (const runId of runIds) {
  const src = traceFile(runId);
  const trace = JSON.parse(readFileSync(src, "utf8")) as Trace;
  const key = trace.metadata.dataset.name.includes("clinic") ? "scheduling" : "pharmacy";
  const scenario = getScenario(loadDataset(key), trace.metadata.scenario_id);
  const dst = join(OUT, src.split(/[\\/]/).pop()!);
  copyFileSync(src, dst);
  const before = JSON.parse(readFileSync(src.replace(/\.json$/, ".eval.json"), "utf8")) as EvalResult;
  const after = await evaluate(trace, scenario, new LlmJudge(judgeClient, trace.metadata.seed));
  writeFileSync(dst.replace(/\.json$/, ".eval.json"), JSON.stringify(after, null, 2) + "\n");

  const mine = labels.filter((l) => l.run_id === runId);
  const itemsBefore = reviewItems(before, []), itemsAfter = reviewItems(after, []);
  for (const l of mine) {
    const b = itemsBefore.find((i) => i.item_id === l.item_id);
    // Same finding after the revision = same text (ids can shift when an earlier check is retired).
    const a = b ? itemsAfter.find((i) => i.text === b.text && i.source === b.source) : undefined;
    rows.push({ run: runId, scenario: trace.metadata.scenario_id, item: l.item_id, text: b?.text ?? l.item_id, human: l.human_passed, before: b?.auto_passed ?? null, after: a?.auto_passed ?? null });
  }
}

const stats = (xs: Row[], which: "before" | "after") => {
  const r = xs.filter((x) => x[which] !== null);
  const agree = r.filter((x) => x[which] === x.human).length;
  return { n: r.length, agree, pct: r.length ? Math.round((agree / r.length) * 100) : null };
};
const part = (pred: (r: Row) => boolean) => rows.filter(pred);
const isRun = (r: Row) => r.item === "run";
const report = {
  findings: { before: stats(part((r) => !isRun(r)), "before"), after: stats(part((r) => !isRun(r)), "after") },
  call_verdicts: { before: stats(part(isRun), "before"), after: stats(part(isRun), "after") },
  changed: rows.filter((r) => r.before !== r.after).map((r) => ({ scenario: r.scenario, item: r.item, text: r.text, human: r.human, before: r.before, after: r.after })),
};
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!existsSync(join(OUT, "README.md"))) writeFileSync(join(OUT, "README.md"), "Re-graded copies of the 16 calls the author labelled, under dataset 2.1.1. Produced by `npx tsx scripts/calibration_rerun.ts`; see CALIBRATION.md. Not loaded by the app.\n");
