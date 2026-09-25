import type { FinalSnapshot } from "../trace/types.js";
import type { BaseWorld } from "./base.js";
import { getScenario, loadDataset, type DatasetKey, type LoadedDataset, type Scenario } from "./dataset.js";
import { PharmacyWorld } from "./pharmacy.js";
import { Recorder } from "./recorder.js";
import { SchedulingWorld } from "./scheduling.js";

export type { AgentToolbox, AgentToolResult, ToolDef } from "./base.js";
export { BaseWorld } from "./base.js";
export { Recorder, VirtualClock } from "./recorder.js";

export function createWorld(dataset: LoadedDataset, scenario: Scenario, recorder: Recorder): BaseWorld {
  return scenario.clinic_fixture ? new SchedulingWorld(dataset, scenario, recorder) : new PharmacyWorld(dataset, scenario, recorder);
}

/** Convenience for tests and the runner: load a dataset, pick a scenario, build its world with a fresh recorder. */
export function worldFor(key: DatasetKey, scenarioId: string): { world: BaseWorld; recorder: Recorder; dataset: LoadedDataset; scenario: Scenario } {
  const dataset = loadDataset(key);
  const scenario = getScenario(dataset, scenarioId);
  const recorder = new Recorder();
  return { world: createWorld(dataset, scenario, recorder), recorder, dataset, scenario };
}

export function finalSnapshot(world: BaseWorld, recorder: Recorder): FinalSnapshot {
  const ev = recorder.events;
  return {
    end_state: world.endState(),
    world_state: world.worldState(),
    tool_calls: world.toolCallSummaries(),
    counts: {
      turns: ev.length ? Math.max(...ev.map((e) => e.turn)) + 1 : 0,
      caller_turns: ev.filter((e) => e.type === "caller_turn").length,
      agent_turns: ev.filter((e) => e.type === "agent_turn").length,
      tool_calls: ev.filter((e) => e.type === "tool_call").length,
      errors: ev.filter((e) => e.type === "error").length,
    },
  };
}
