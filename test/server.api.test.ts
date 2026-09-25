/**
 * The app's queries over a throwaway database: golden runs in two batches, evaluated without a judge.
 *  - import: batch = folder, eval summaries stored;
 *  - a human run label overrides the verdict everywhere (runs list, batch stats, compare);
 *  - calibration counts agreement and the direction of disagreements;
 *  - labels persist to a file and load back.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/eval/evaluate.js";
import { loadGoldens, scriptsFor } from "../src/runner/golden.js";
import { runScenario } from "../src/runner/runner.js";
import { batchStats, calibration, compare, getRun, listRuns, patterns } from "../src/server/api.js";
import { Db } from "../src/server/db.js";

const root = mkdtempSync(join(tmpdir(), "harbor-app-"));
const labelsFile = join(root, "labels.json");
const ids: Record<string, string> = {};

beforeAll(async () => {
  for (const [batch, golden] of [["v1", "A02.bad"], ["v2", "A02.good"]] as const) {
    const g = scriptsFor(loadGoldens().find((x) => x.id === golden)!);
    const trace = await runScenario({ dataset: g.dataset, scenario: g.scenario, agent: g.agent, caller: g.caller, mode: "scripted" });
    const ev = await evaluate(trace, g.scenario, null);
    mkdirSync(join(root, "runs", batch), { recursive: true });
    writeFileSync(join(root, "runs", batch, `${golden}.json`), JSON.stringify(trace));
    writeFileSync(join(root, "runs", batch, `${golden}.eval.json`), JSON.stringify(ev));
    ids[batch] = trace.metadata.run_id;
  }
});

function freshDb() {
  const db = new Db();
  db.importRuns(join(root, "runs"));
  db.importLabels(labelsFile);
  return db;
}

describe("app queries", () => {
  it("imports runs by batch with their evaluation", () => {
    const db = freshDb();
    const runs = listRuns(db);
    expect(runs.map((r) => [r.batch, r.scenario_id, r.verdict])).toEqual([["v1", "A02", "fail"], ["v2", "A02", "pass"]]);
    expect(getRun(db, ids.v1!)!.review.find((i) => i.item_id === "A02.state.3")).toMatchObject({ source: "state", auto_passed: false, human: null });
    expect(batchStats(db, "v2")).toMatchObject({ runs: 1, pass: 1, pass_rate: 1 });
  });

  it("compare shows the per-scenario change", () => {
    const c = compare(freshDb(), "v1", "v2");
    expect(c.rows).toEqual([expect.objectContaining({ scenario_id: "A02", change: "improved" })]);
    expect(c.a.pass_rate).toBe(0);
    expect(c.b.pass_rate).toBe(1);
  });

  it("a human run label overrides the verdict; calibration counts it; labels persist to the file", () => {
    const db = freshDb();
    db.setLabel(ids.v2!, "run", false, "reviewer disagrees", labelsFile);   // evaluator said pass
    db.setLabel(ids.v1!, "A02.state.3", false, "", labelsFile);             // evaluator said fail: agrees
    const v2 = listRuns(db, { batch: "v2" })[0]!;
    expect(v2).toMatchObject({ verdict: "pass", effective_verdict: "fail", overridden: true });
    expect(compare(db, "v1", "v2").rows[0]!.change).toBe("same");

    const reloaded = freshDb();                                               // from the labels file alone
    const cal = calibration(reloaded);
    expect(cal.bySource.run).toMatchObject({ n: 1, agree: 0, evaluator_too_lenient: 1 });
    expect(cal.bySource.state).toMatchObject({ n: 1, agree: 1 });
    expect(cal.disagreements.map((d) => d.item_id)).toEqual(["run"]);

    reloaded.setLabel(ids.v2!, "run", null, "", labelsFile);                  // clearing restores the evaluator's verdict
    expect(listRuns(freshDb(), { batch: "v2" })[0]!.effective_verdict).toBe("pass");
  });

  it("patterns aggregate failed checks across runs", () => {
    const p = patterns(freshDb());
    expect(p.runs).toBe(2);
    expect(p.failedItems.some((f) => f.item_id === "A02.state.3" && f.scenario_id === "A02")).toBe(true);
    expect(p.byFailureType.carelessness).toBeGreaterThan(0);
  });
});
