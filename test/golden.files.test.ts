/**
 * World-level consistency of the golden files: replaying each golden's tool calls, in order, directly through the
 * mock world must produce exactly the tool results and end state the file expects. (runner.golden.test.ts plays the
 * same files through the full turn loop.)
 */
import { describe, expect, it } from "vitest";
import { loadGoldens } from "../src/runner/golden.js";
import { worldFor } from "../src/world/index.js";

const GOLDENS = loadGoldens();

describe("golden files", () => {
  it("exist and are all approved", () => {
    expect(GOLDENS.map((g) => g.id).sort()).toEqual(["A02.bad", "A02.good", "A02.good_late", "S11-F1.bad", "S11-F1.good"]);
    for (const g of GOLDENS) expect(g.status, g.id).toBe("approved");
  });

  for (const g of GOLDENS) {
    it(`${g.id}: turns alternate caller/agent, starting with the caller`, () => {
      g.turns.forEach((t, i) => expect("caller" in t, `${g.id} turn ${i}`).toBe(i % 2 === 0));
    });

    it(`${g.id}: replaying its tool calls through the world gives the expected results and end state`, () => {
      const env = worldFor(g.dataset, g.scenario_id);
      const codes: [string, string][] = [];
      for (const t of g.turns) {
        if (!("agent" in t)) continue;
        for (const c of t.agent.tool_calls) {
          env.world.callTool(c.tool, c.args);
          const res = [...env.recorder.events].reverse().find((e) => e.type === "tool_result") as { tool: string; result_code: string };
          codes.push([res.tool, res.result_code]);
        }
      }
      expect(codes).toEqual(g.expect.tool_results);
      expect(env.world.endState()).toEqual(g.expect.end_state);
    });
  }
});
