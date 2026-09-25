/**
 * Golden regression tests (M2): each golden file is played through the FULL turn loop (ScriptedCaller +
 * ScriptedAgent + runner + mock world). The resulting trace must be schema-valid, play the script exactly,
 * and end in exactly the state the golden expects.
 */
import { describe, expect, it } from "vitest";
import { loadGoldens, scriptsFor } from "../src/runner/golden.js";
import { runScenario } from "../src/runner/runner.js";
import type { Trace, TraceEvent } from "../src/trace/types.js";
import { validateTrace } from "../src/trace/validate.js";

const of = <T extends TraceEvent["type"]>(t: Trace, type: T) => t.events.filter((e) => e.type === type) as Extract<TraceEvent, { type: T }>[];

describe.each(loadGoldens().map((g) => [g.id, g] as const))("golden %s", (_id, golden) => {
  const play = async () => {
    const g = scriptsFor(golden);
    const trace = await runScenario({ dataset: g.dataset, scenario: g.scenario, agent: g.agent, caller: g.caller, mode: "scripted" });
    return { trace, g };
  };

  it("produces a schema-valid trace with run_status completed", async () => {
    const { trace } = await play();
    expect(validateTrace(trace).errors).toEqual([]);
    expect(trace.metadata.run_status).toBe("completed");
    expect(trace.metadata).toMatchObject({ mode: "scripted", agent: { id: "scripted", prompt_sha256: null }, caller: { type: "scripted" } });
  });

  it("plays the whole script: same caller lines, same agent lines, nothing left over", async () => {
    const { trace, g } = await play();
    const script = golden.turns;
    expect(of(trace, "caller_turn").map((e) => e.text)).toEqual(script.flatMap((t) => ("caller" in t ? [t.caller] : [])));
    expect(of(trace, "agent_turn").map((e) => e.text)).toEqual(script.flatMap((t) => ("agent" in t ? [t.agent.text] : [])));
    expect(g.caller.remaining()).toBe(0);
    expect(g.agent.remaining()).toBe(0);
  });

  it("gives the expected tool results, end state and call-end reason", async () => {
    const { trace } = await play();
    expect(of(trace, "tool_result").map((e) => [e.tool, e.result_code])).toEqual(golden.expect.tool_results);
    expect(trace.final.end_state).toEqual(golden.expect.end_state);
    expect(of(trace, "call_end").map((e) => e.reason)).toEqual([golden.expect.call_end_reason]);
  });

  it("is deterministic: two runs give identical events and final state", async () => {
    const a = (await play()).trace, b = (await play()).trace;
    expect(b.events).toEqual(a.events);
    expect(b.final).toEqual(a.final);
  });
});

describe("golden pairs differ where they should", () => {
  const run = async (id: string) => {
    const g = scriptsFor(loadGoldens().find((x) => x.id === id)!);
    return runScenario({ dataset: g.dataset, scenario: g.scenario, agent: g.agent, caller: g.caller, mode: "scripted" });
  };

  it("S11-F1: good and bad end with the same tool failure; only the good one creates a follow-up", async () => {
    const good = await run("S11-F1.good"), bad = await run("S11-F1.bad");
    expect(good.final.end_state.transfers).toEqual([]);
    expect(bad.final.end_state.transfers).toEqual([]);
    expect(good.final.end_state.pharmacist_callbacks).toHaveLength(1);
    expect(bad.final.end_state.pharmacist_callbacks).toHaveLength(0);
  });

  it("A02: good leaves one upcoming appointment, bad leaves two (the orphan)", async () => {
    const upcoming = (t: Trace) => ((t.final.world_state as any).appointments as any[])
      .filter((a) => a.patient === "Gloria Hart" && a.status === "booked").map((a) => a.appointment_id).sort();
    expect(upcoming(await run("A02.good"))).toEqual(["APT-NEW-PAT-20261001-1400"]);
    expect(upcoming(await run("A02.good_late"))).toEqual(["APT-NEW-PAT-20261001-1400"]);
    expect(upcoming(await run("A02.bad"))).toEqual(["APT-GH-0929", "APT-NEW-PAT-20261001-1400"]);
  });
});
