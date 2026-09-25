/**
 * A batch: a set of scenarios x N trials against one agent version, saved under runs/<batch>/.
 *
 * Per call:  run (agent + simulated caller) -> validity checks (M6) -> evaluation -> files:
 *   runs/<batch>/<scenario>.t<trial>.json        the trace (with its validity block)
 *   runs/<batch>/<scenario>.t<trial>.eval.json   the evaluation
 *   runs/<batch>/index.jsonl                     one summary line per call (rewritten at the end)
 *
 * Resumable: a call whose trace already exists (and didn't break) is skipped, so an interrupted batch restarts
 * where it stopped. Every LLM response goes through the cache, so a finished batch replays with no key.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmAgent } from "../agents/llm.js";
import { renderAgentPrompt, type PromptVersion } from "../agents/prompt.js";
import { SimulatedCaller } from "../caller/simulated.js";
import { evaluate, type EvalResult } from "../eval/evaluate.js";
import { LlmJudge } from "../eval/judge.js";
import { applyValidity, checkValidity, llmCallerAuditor } from "../eval/validity.js";
import { LlmCache, type CacheMode } from "../llm/cache.js";
import { ChatClient, llmConfigFromEnv } from "../llm/openai-compat.js";
import type { LlmCallInfo, Trace } from "../trace/types.js";
import { loadDataset, REPO_ROOT, type DatasetKey, type LoadedDataset, type Scenario } from "../world/dataset.js";
import { runScenario } from "./runner.js";

export const RUNS_DIR = join(REPO_ROOT, "runs");

export interface BatchOptions {
  batch: string;
  datasets: DatasetKey[];
  /** Only these scenario ids (default: every active scenario in the datasets). */
  scenarios?: string[];
  trials: number;
  mode: CacheMode & ("live" | "replay");
  agentVersion: PromptVersion;
  concurrency: number;
  evaluate: boolean;
  force: boolean;
  log?: (line: string) => void;
}

export interface BatchRow {
  run_id: string; scenario_id: string; trial: number; file: string;
  run_status: string; verdict: string | null; state: string; false_claims: number | null; judged: string;
  validity: string; tokens: Record<string, { input: number; output: number; calls: number }>;
  skipped?: boolean; error?: string;
}

interface Job { ds: LoadedDataset; scenario: Scenario; trial: number }

const isActive = (s: Scenario) => ((s as { status?: string }).status ?? "active") === "active";

/** Tokens per model across the run and its evaluation (cache hits included: they cost nothing now, but did once). */
export function tokenUsage(trace: Trace, ev: EvalResult | null, extra: LlmCallInfo[] = []): BatchRow["tokens"] {
  const out: BatchRow["tokens"] = {};
  const add = (model: string | null, calls: LlmCallInfo[] | undefined) => {
    for (const c of calls ?? []) {
      const k = model ?? "unknown";
      const t = (out[k] ??= { input: 0, output: 0, calls: 0 });
      t.input += c.usage?.input_tokens ?? 0; t.output += c.usage?.output_tokens ?? 0; t.calls += 1;
    }
  };
  for (const e of trace.events) {
    if (e.type === "agent_turn") add(trace.metadata.agent.model, e.llm_calls ?? (e.llm ? [e.llm] : []));
    if (e.type === "caller_turn" || e.type === "director_decision") add(trace.metadata.caller.model, e.llm_calls);
  }
  if (ev?.judge) add(ev.judge.model, [...(ev.judge.llm_calls ?? []), ...extra]);
  else add("validity-auditor", extra);
  return out;
}

export async function runBatch(o: BatchOptions): Promise<BatchRow[]> {
  const log = o.log ?? (() => {});
  const dir = join(RUNS_DIR, o.batch);
  mkdirSync(dir, { recursive: true });
  const cache = new LlmCache(o.mode);
  const agentClient = new ChatClient(llmConfigFromEnv("AGENT"), cache);
  const callerClient = new ChatClient(llmConfigFromEnv("CALLER"), cache);
  const judgeClient = new ChatClient(llmConfigFromEnv("JUDGE"), cache);

  const jobs: Job[] = [];
  for (const key of o.datasets) {
    const ds = loadDataset(key);
    for (const s of ds.data.scenarios) {
      if (!isActive(s) || (o.scenarios && !o.scenarios.includes(s.id))) continue;
      for (let t = 0; t < o.trials; t++) jobs.push({ ds, scenario: s, trial: t });
    }
  }
  log(`batch ${o.batch}: ${jobs.length} call(s), agent ${o.agentVersion}, mode ${o.mode}, ${o.concurrency} at a time`);

  const rows: BatchRow[] = [];
  let done = 0;
  const one = async ({ ds, scenario, trial }: Job): Promise<BatchRow> => {
    const base = `${scenario.id}.t${trial}`;
    const file = join(dir, `${base}.json`);
    if (!o.force && existsSync(file)) {
      const prev = JSON.parse(readFileSync(file, "utf8")) as Trace;
      const broke = prev.metadata.run_status === "agent_error" || prev.metadata.run_status === "harness_error";
      if (!broke) {
        const evFile = join(dir, `${base}.eval.json`);
        const ev = existsSync(evFile) ? (JSON.parse(readFileSync(evFile, "utf8")) as EvalResult) : null;
        return { ...summarize(prev, ev, `runs/${o.batch}/${base}.json`, trial, []), skipped: true };
      }
    }
    const seed = trial + 1;
    const prompt = renderAgentPrompt(o.agentVersion, ds.data);
    const agent = new LlmAgent(ds.data, agentClient, { seed, id: o.agentVersion, promptVersion: o.agentVersion, promptText: prompt });
    const caller = new SimulatedCaller(ds.data, scenario, callerClient, { seed });
    let trace = await runScenario({ dataset: ds, scenario, agent, caller, mode: o.mode, seed, trialIndex: trial });
    const v = await checkValidity(trace, scenario, llmCallerAuditor(judgeClient, seed));
    trace = applyValidity(trace, v.validity);
    writeFileSync(file, JSON.stringify(trace, null, 2) + "\n");
    let ev: EvalResult | null = null;
    if (o.evaluate) {
      ev = await evaluate(trace, scenario, new LlmJudge(judgeClient, seed));
      writeFileSync(join(dir, `${base}.eval.json`), JSON.stringify(ev, null, 2) + "\n");
    }
    return summarize(trace, ev, `runs/${o.batch}/${base}.json`, trial, v.llm_calls);
  };

  // A small worker pool: N calls in flight, each call's own turns still strictly in order.
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      let row: BatchRow;
      try { row = await one(job); } catch (e) {
        row = { run_id: "", scenario_id: job.scenario.id, trial: job.trial, file: "", run_status: "harness_error", verdict: null, state: "–", false_claims: null, judged: "–", validity: "–", tokens: {}, error: e instanceof Error ? e.message : String(e) };
      }
      rows.push(row);
      done += 1;
      log(`[${done}/${jobs.length}] ${row.scenario_id} t${row.trial}  ${row.skipped ? "(already done) " : ""}${row.error ? `ERROR ${row.error.slice(0, 160)}` : `${row.verdict ?? row.run_status}  state ${row.state}  false claims ${row.false_claims ?? "–"}  judged ${row.judged}  validity ${row.validity}`}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));

  rows.sort((a, b) => a.scenario_id.localeCompare(b.scenario_id) || a.trial - b.trial);
  writeIndex(o.batch);
  return rows;
}

/** index.jsonl lists EVERY call in the batch folder, so re-running a few scenarios never drops the others. */
export function writeIndex(batch: string): void {
  const dir = join(RUNS_DIR, batch);
  const rows = readdirSync(dir).filter((f) => /\.t\d+\.json$/.test(f)).map((f) => {
    const trace = JSON.parse(readFileSync(join(dir, f), "utf8")) as Trace;
    const evFile = join(dir, f.replace(/\.json$/, ".eval.json"));
    const ev = existsSync(evFile) ? (JSON.parse(readFileSync(evFile, "utf8")) as EvalResult) : null;
    return summarize(trace, ev, `runs/${batch}/${f}`, trace.metadata.trial_index, []);
  }).sort((a, b) => a.scenario_id.localeCompare(b.scenario_id) || a.trial - b.trial);
  writeFileSync(join(dir, "index.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function summarize(trace: Trace, ev: EvalResult | null, file: string, trial: number, validityCalls: LlmCallInfo[]): BatchRow {
  const s = ev?.summary;
  const bad = (trace.validity?.checks ?? []).filter((c) => c.status !== "pass");
  return {
    run_id: trace.metadata.run_id, scenario_id: trace.metadata.scenario_id, trial, file,
    run_status: trace.metadata.run_status, verdict: s?.verdict ?? null,
    state: s ? `${s.state_passed}/${s.state_total}` : "–", false_claims: s?.violations ?? null,
    judged: s ? `${s.judged_passed}/${s.judged_applicable}` : "–",
    validity: bad.length ? bad.map((c) => `${c.name}:${c.status}`).join(",") : "ok",
    tokens: tokenUsage(trace, ev, validityCalls),
  };
}
