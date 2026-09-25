/**
 * Evaluate saved traces.
 *
 *   npx tsx src/cli/evaluate.ts <trace.json> [more.json ...] [live|replay] [--no-judge]
 *
 * Writes <trace>.eval.json next to each trace and prints a report. The judge's calls are cached like any other
 * LLM call, so `replay` re-evaluates saved traces with no API key.
 */
import "../env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { LlmJudge } from "../eval/judge.js";
import { evaluate } from "../eval/evaluate.js";
import { formatEval } from "./evaluate-format.js";
import { LlmCache } from "../llm/cache.js";
import { ChatClient, llmConfigFromEnv } from "../llm/openai-compat.js";
import type { Trace } from "../trace/types.js";
import { getScenario, loadDataset } from "../world/dataset.js";

const args = process.argv.slice(2);
const mode = args.includes("replay") ? "replay" : "live";
const files = args.filter((a) => a.endsWith(".json"));
const judge = args.includes("--no-judge") ? null : new LlmJudge(new ChatClient(llmConfigFromEnv("JUDGE"), new LlmCache(mode)));

for (const f of files) {
  const trace = JSON.parse(readFileSync(f, "utf8")) as Trace;
  const key = trace.metadata.dataset.name.includes("clinic") ? "scheduling" : "pharmacy";
  const scenario = getScenario(loadDataset(key), trace.metadata.scenario_id);
  const result = await evaluate(trace, scenario, judge);
  writeFileSync(f.replace(/\.json$/, ".eval.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(formatEval(result) + "\n");
}
