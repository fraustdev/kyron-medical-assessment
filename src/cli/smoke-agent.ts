/**
 * M3 smoke test: the REAL agent (LLM) against a ScriptedCaller, so only one source of randomness is live.
 * The caller replays a golden's caller lines verbatim (they don't adapt to what the agent says, so some turns will
 * read oddly; that is expected until the simulated caller exists in M4).
 *
 *   npx tsx src/cli/smoke-agent.ts [golden-id] [live|replay]      e.g. A02.good live
 *
 * Writes the trace to research/model-comparison/<golden-id>.<model>.json and prints a readable transcript.
 */
import "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmAgent } from "../agents/llm.js";
import { ScriptedCaller } from "../caller/scripted.js";
import { LlmCache, type CacheMode } from "../llm/cache.js";
import { ChatClient, llmConfigFromEnv } from "../llm/openai-compat.js";
import { loadGoldens } from "../runner/golden.js";
import { runScenario } from "../runner/runner.js";
import { getScenario, loadDataset, REPO_ROOT } from "../world/dataset.js";
import { formatTrace } from "./format.js";

const goldenId = process.argv[2] ?? "A02.good";
const mode = (process.argv[3] ?? "live") as CacheMode & ("live" | "replay");
const golden = loadGoldens().find((g) => g.id === goldenId);
if (!golden) throw new Error(`no golden ${goldenId}`);

const dataset = loadDataset(golden.dataset);
const lines = golden.turns.flatMap((t) => ("caller" in t ? [t.caller] : []));
const last = golden.turns[golden.turns.length - 1]!;
const client = new ChatClient(llmConfigFromEnv("AGENT"), new LlmCache(mode));
const trace = await runScenario({
  dataset, scenario: getScenario(dataset, golden.scenario_id),
  agent: new LlmAgent(dataset.data, client, {
    seed: 1,
    ...(process.env.AGENT_MAX_TOKENS ? { maxTokens: Number(process.env.AGENT_MAX_TOKENS) } : {}),
    ...(process.env.AGENT_REASONING_EFFORT ? { reasoningEffort: process.env.AGENT_REASONING_EFFORT as "none" } : {}),
  }),
  caller: new ScriptedCaller(lines, "caller" in last),
  mode,
});

const out = join(REPO_ROOT, "research", "model-comparison");
mkdirSync(out, { recursive: true });
const file = `${goldenId}.${String(trace.metadata.agent.model).replace(/[^a-z0-9.]+/gi, "_")}.json`;
writeFileSync(join(out, file), JSON.stringify(trace, null, 2) + "\n");
console.log(formatTrace(trace));
console.log(`\nsaved research/model-comparison/${file}`);
