/**
 * The harness CLI.
 *
 *   npm run sim -- run   --batch <name> [--dataset pharmacy|scheduling|all] [--scenarios S01,A02] [--trials 1]
 *                        [--agent v1] [--mode live|replay] [--concurrency 4] [--no-eval] [--force]
 *   npm run sim -- show  <run-id | path/to/trace.json>
 *   npm run sim -- list  [--batch <name>]
 *   npm run sim -- compare <batch-a> <batch-b>
 *
 * `run` saves every call under runs/<batch>/ (trace + evaluation) and prints a summary with token use.
 * `replay` re-runs a finished batch from the committed LLM cache: no API key, identical results.
 */
import "../env.js";
import { existsSync, readFileSync } from "node:fs";
import { PROMPT_VERSIONS, type PromptVersion } from "../agents/prompt.js";
import type { EvalResult } from "../eval/evaluate.js";
import { compare, listRuns } from "../server/api.js";
import { inMemoryDb } from "../server/db.js";
import type { Trace } from "../trace/types.js";
import type { DatasetKey } from "../world/dataset.js";
import { runBatch, type BatchRow } from "../runner/batch.js";
import { formatTrace } from "./format.js";
import { formatEval } from "./evaluate-format.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[i + 1]! : fallback;
};
const die = (msg: string): never => { console.error(msg); process.exit(1); };

/** Approximate list prices, USD per million tokens (input, output). Only for the summary line. */
const PRICE: Record<string, [number, number]> = { "claude-haiku-4-5-20251001": [1, 5], "claude-sonnet-5": [3, 15] };

async function run() {
  const batch = opt("batch") ?? die("--batch <name> is required");
  const ds = opt("dataset", "all")!;
  const datasets: DatasetKey[] = ds === "all" ? ["pharmacy", "scheduling"] : ds === "pharmacy" || ds === "scheduling" ? [ds] : die(`unknown --dataset ${ds}`);
  const agent = opt("agent", "v1")! as PromptVersion;
  if (!PROMPT_VERSIONS.includes(agent)) die(`unknown --agent ${agent} (have: ${PROMPT_VERSIONS.join(", ")})`);
  const m = opt("mode", "live")!;
  const mode: "live" | "replay" = m === "live" || m === "replay" ? m : die("--mode must be live or replay");
  const t0 = Date.now();
  const rows = await runBatch({
    batch, datasets, scenarios: opt("scenarios")?.split(",").map((s) => s.trim()),
    trials: Number(opt("trials", "1")), mode, agentVersion: agent,
    concurrency: Number(opt("concurrency", "4")), evaluate: !flag("no-eval"), force: flag("force"),
    log: (l) => console.log(l),
  });
  console.log(`\n${summaryTable(rows)}\n\nfinished in ${Math.round((Date.now() - t0) / 1000)}s. Open the app (npm run app) and pick batch "${batch}".`);
}

function summaryTable(rows: BatchRow[]): string {
  const scored = rows.filter((r) => r.verdict === "pass" || r.verdict === "fail");
  const pass = scored.filter((r) => r.verdict === "pass").length;
  const out = [
    `${rows.length} calls: ${pass} passed, ${scored.length - pass} failed, ${rows.filter((r) => r.verdict === "invalid").length} not scored (broken or untrustworthy), ${rows.filter((r) => r.error).length} errors.`,
    "",
    "scenario   trial  result     state   false  judged  validity",
    ...rows.map((r) => `${r.scenario_id.padEnd(10)} ${String(r.trial).padEnd(6)} ${(r.error ? "ERROR" : r.verdict ?? r.run_status).padEnd(10)} ${r.state.padEnd(7)} ${String(r.false_claims ?? "–").padEnd(6)} ${r.judged.padEnd(7)} ${r.validity}`),
  ];
  const tokens: Record<string, { input: number; output: number; calls: number }> = {};
  for (const r of rows) if (!r.skipped) for (const [m, t] of Object.entries(r.tokens)) {
    const x = (tokens[m] ??= { input: 0, output: 0, calls: 0 });
    x.input += t.input; x.output += t.output; x.calls += t.calls;
  }
  let usd = 0;
  out.push("", "tokens this session (calls already done before are not counted):");
  for (const [m, t] of Object.entries(tokens)) {
    const p = PRICE[m];
    const cost = p ? (t.input / 1e6) * p[0] + (t.output / 1e6) * p[1] : 0;
    usd += cost;
    out.push(`  ${m.padEnd(28)} ${t.calls} calls, ${t.input.toLocaleString()} in / ${t.output.toLocaleString()} out${p ? `  ≈ $${cost.toFixed(2)}` : ""}`);
  }
  out.push(`  ≈ $${usd.toFixed(2)} at list prices (cached responses were counted when first made)`);
  return out.join("\n");
}

function show() {
  const target = rest[0] ?? die("usage: sim show <run-id | trace.json>");
  let file = target;
  if (!existsSync(file)) {
    const row = listRuns(inMemoryDb()).find((r) => r.run_id === target) ?? die(`no run ${target}`);
    file = row.trace_path;
  }
  const trace = JSON.parse(readFileSync(file, "utf8")) as Trace;
  console.log(formatTrace(trace));
  if (trace.validity) console.log(`\nVALIDITY\n${trace.validity.checks.map((c) => `  ${c.status.padEnd(12)} ${c.name}: ${c.details.join("; ")}`).join("\n")}`);
  const evFile = file.replace(/\.json$/, ".eval.json");
  if (existsSync(evFile)) console.log(`\nEVALUATION\n${formatEval(JSON.parse(readFileSync(evFile, "utf8")) as EvalResult)}`);
}

function list() {
  const runs = listRuns(inMemoryDb(), opt("batch") ? { batch: opt("batch")! } : {});
  console.log("batch                scenario  trial  result     state  false  judged  run id");
  for (const r of runs) console.log(`${r.batch.padEnd(20)} ${r.scenario_id.padEnd(9)} ${String(r.trial_index).padEnd(6)} ${(r.effective_verdict ?? r.run_status).padEnd(10)} ${(r.state_total ? `${r.state_passed}/${r.state_total}` : "–").padEnd(6)} ${String(r.violations ?? "–").padEnd(6)} ${(r.judged_applicable ? `${r.judged_passed}/${r.judged_applicable}` : "–").padEnd(7)} ${r.run_id}`);
  console.log(`\n${runs.length} run(s). Read from runs/ and labels/.`);
}

function compareCmd() {
  const [a, b] = rest.filter((x) => !x.startsWith("--"));
  if (!a || !b) die("usage: sim compare <batch-a> <batch-b>");
  const c = compare(inMemoryDb(), a!, b!);
  const pct = (x: number | null) => (x === null ? "  –" : `${Math.round(x * 100)}%`.padStart(4));
  const row = (label: string, x: number | null, y: number | null, rate = true) =>
    `${label.padEnd(32)} ${(rate ? pct(x) : String(x ?? "–")).padStart(6)} ${(rate ? pct(y) : String(y ?? "–")).padStart(6)}   ${x === null || y === null ? "" : rate ? `${y - x >= 0 ? "+" : ""}${Math.round((y - x) * 100)} pts` : `${y - x >= 0 ? "+" : ""}${y - x}`}`;
  console.log(`${"".padEnd(32)} ${a!.padStart(6)} ${b!.padStart(6)}   change`);
  console.log(row("Calls passed", c.a.pass_rate, c.b.pass_rate));
  console.log(row("Required outcomes met", c.a.state_pass_rate, c.b.state_pass_rate));
  console.log(row("Caller-handling checks passed", c.a.judged_pass_rate, c.b.judged_pass_rate));
  console.log(row("Calls with a false claim", c.a.runs_with_false_claims, c.b.runs_with_false_claims, false));
  console.log(row("False claims", c.a.false_claims, c.b.false_claims, false));
  console.log(row("Scored calls", c.a.evaluated - c.a.invalid, c.b.evaluated - c.b.invalid, false));
  console.log(row("Not scored (unfair test)", c.a.invalid, c.b.invalid, false));
  console.log("\nscenario   before  after   change      outcomes          false claims");
  const order: Record<string, number> = { regressed: 0, improved: 1, same: 2, missing: 3 };
  for (const r of [...c.rows].sort((x, y) => order[x.change]! - order[y.change]! || x.scenario_id.localeCompare(y.scenario_id))) {
    const v = (x: typeof r.a) => (x ? x.runs.map((q) => q.verdict).join("/") : "–");
    console.log(`${r.scenario_id.padEnd(10)} ${v(r.a).padEnd(7)} ${v(r.b).padEnd(7)} ${r.change.padEnd(11)} ${pct(r.a?.state_pass_rate ?? null)} -> ${pct(r.b?.state_pass_rate ?? null)}      ${r.a?.false_claims ?? "–"} -> ${r.b?.false_claims ?? "–"}`);
  }
}

if (cmd === "run") await run();
else if (cmd === "show") show();
else if (cmd === "list") list();
else if (cmd === "compare") compareCmd();
else die("usage: sim run|show|list|compare  (see src/cli/sim.ts)");
