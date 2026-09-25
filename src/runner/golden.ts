/** Load golden traces (golden/*.json) and turn them into a ScriptedCaller + ScriptedAgent pair. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedAgent, type ScriptedAgentTurn } from "../agents/scripted.js";
import { ScriptedCaller } from "../caller/scripted.js";
import { getScenario, loadDataset, REPO_ROOT, type DatasetKey, type LoadedDataset, type Scenario } from "../world/dataset.js";

export const GOLDEN_DIR = join(REPO_ROOT, "golden");

export interface GoldenFile {
  golden_version: string;
  id: string;
  dataset: DatasetKey;
  scenario_id: string;
  label: "good" | "bad";
  status: string;
  description: string;
  turns: ({ caller: string } | { agent: ScriptedAgentTurn })[];
  expect: { tool_results: [string, string][]; end_state: Record<string, unknown>; call_end_reason: string };
  for_part3?: string;
}

export function loadGoldens(dir = GOLDEN_DIR): GoldenFile[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as GoldenFile);
}

export interface GoldenRun { golden: GoldenFile; dataset: LoadedDataset; scenario: Scenario; caller: ScriptedCaller; agent: ScriptedAgent }

export function scriptsFor(golden: GoldenFile): GoldenRun {
  const callerLines = golden.turns.flatMap((t) => ("caller" in t ? [t.caller] : []));
  const agentTurns = golden.turns.flatMap((t) => ("agent" in t ? [t.agent] : []));
  const last = golden.turns[golden.turns.length - 1];
  // A golden that ends on a caller line: the caller hangs up after it. Ending on an agent turn: the call
  // ends after the agent speaks (the caller has nothing more to say).
  const hangUpAfterLast = last !== undefined && "caller" in last;
  const dataset = loadDataset(golden.dataset);
  return {
    golden, dataset, scenario: getScenario(dataset, golden.scenario_id),
    caller: new ScriptedCaller(callerLines, hangUpAfterLast),
    agent: new ScriptedAgent(agentTurns),
  };
}
