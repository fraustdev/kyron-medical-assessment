/**
 * M4 smoke test: the real agent against the simulated caller (or you, with --human).
 *
 *   npx tsx src/cli/smoke-sim.ts <scenario-id> [live|replay] [--human]      e.g. A02 live
 *
 * Writes the trace to research/early-runs/first-live-calls/<scenario>.<agent-model>.json and prints a readable transcript.
 */
import "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmAgent } from "../agents/llm.js";
import { HumanCaller } from "../caller/human.js";
import { SimulatedCaller } from "../caller/simulated.js";
import { LlmCache, type CacheMode } from "../llm/cache.js";
import { ChatClient, llmConfigFromEnv } from "../llm/openai-compat.js";
import { runScenario } from "../runner/runner.js";
import { getScenario, loadDataset, REPO_ROOT } from "../world/dataset.js";
import { formatTrace } from "./format.js";

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--") && a !== "live" && a !== "replay") ?? "A02";
const mode = (args.includes("replay") ? "replay" : "live") as CacheMode & ("live" | "replay");
const human = args.includes("--human");
const seed = 1;

const dataset = loadDataset(id.startsWith("A") ? "scheduling" : "pharmacy");
const scenario = getScenario(dataset, id);
const cache = new LlmCache(mode);
const agent = new LlmAgent(dataset.data, new ChatClient(llmConfigFromEnv("AGENT"), cache), { seed });
const caller = human ? new HumanCaller(scenario) : new SimulatedCaller(dataset.data, scenario, new ChatClient(llmConfigFromEnv("CALLER"), cache), { seed });

const trace = await runScenario({ dataset, scenario, agent, caller, mode: human ? "live" : mode, seed });

const out = join(REPO_ROOT, "research", "early-runs", "first-live-calls");
mkdirSync(out, { recursive: true });
const file = `${id}.${human ? "human" : "sim"}.${String(trace.metadata.agent.model).replace(/[^a-z0-9.]+/gi, "_")}.json`;
writeFileSync(join(out, file), JSON.stringify(trace, null, 2) + "\n");
console.log(formatTrace(trace));
console.log(`\nsaved research/early-runs/first-live-calls/${file}`);
