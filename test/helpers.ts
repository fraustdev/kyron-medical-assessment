import { validateTrace } from "../src/trace/validate.js";
import type { Trace, TraceEvent } from "../src/trace/types.js";
import type { DatasetKey } from "../src/world/dataset.js";
import { finalSnapshot, worldFor } from "../src/world/index.js";

export function setup(key: DatasetKey, scenarioId: string) {
  const env = worldFor(key, scenarioId);
  const call = (tool: string, args: Record<string, unknown>) => env.world.callTool(tool, args);
  const lastResult = () => [...env.recorder.events].reverse().find((e) => e.type === "tool_result") as Extract<TraceEvent, { type: "tool_result" }>;
  const state = () => env.world.endState() as Record<string, any>;
  const eventsFor = (call_id: string) => env.recorder.events.filter((e) => "call_id" in e && e.call_id === call_id);
  return { ...env, call, lastResult, state, eventsFor };
}

/** Wrap the world's events + snapshot in a minimal trace and validate it against trace.schema.json. */
export function traceOf(env: ReturnType<typeof setup>): { trace: Trace; errors: string[] } {
  const trace: Trace = {
    trace_version: "1.0.0",
    metadata: {
      run_id: `run_test_${env.scenario.id}`, scenario_id: env.scenario.id,
      dataset: { name: env.dataset.data.dataset, version: env.dataset.data.version, file_sha256: env.dataset.sha256 },
      agent: { id: "test", version: "0", provider: null, model: null, prompt_sha256: null, prompt_text: null },
      caller: { type: "scripted", provider: null, model: null, director_version: null },
      seed: 0, trial_index: 0, mode: "scripted",
      started_at: "2026-09-24T16:40:00.000Z", ended_at: "2026-09-24T16:41:00.000Z",
      run_status: "completed", harness_version: "0.1.0", turn_cap: 30, simulated_now: env.dataset.data.simulated_now,
    },
    events: env.recorder.events,
    final: finalSnapshot(env.world, env.recorder),
  };
  return { trace, errors: validateTrace(trace).errors };
}
