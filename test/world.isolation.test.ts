/**
 * Isolation + coverage guarantees:
 *  - every tool a dataset declares is implemented, and nothing else is;
 *  - the agent-facing surface is exactly { toolDefs, callTool };
 *  - tool definitions contain no fixture data (names, DOBs, rx ids, slot/appointment ids) for ANY scenario;
 *  - the TypeScript calendar produces exactly the same slot grid as scripts/calendar_lib.py.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { allSlots } from "../src/world/calendar.js";
import { declaredToolNames, loadDataset, REPO_ROOT, type DatasetKey } from "../src/world/dataset.js";
import { createWorld, Recorder } from "../src/world/index.js";

const KEYS: DatasetKey[] = ["pharmacy", "scheduling"];

describe.each(KEYS)("%s dataset", (key) => {
  const ds = loadDataset(key);

  it("implements exactly the declared tools, in every scenario", () => {
    for (const s of ds.data.scenarios) {
      const w = createWorld(ds, s, new Recorder());
      expect(w.implementedTools().sort(), s.id).toEqual(declaredToolNames(ds.data).sort());
    }
  });

  it("exposes only toolDefs + callTool to agents", () => {
    const w = createWorld(ds, ds.data.scenarios[0]!, new Recorder());
    expect(Object.keys(w.toolbox()).sort()).toEqual(["callTool", "toolDefs"]);
    expect(Object.isFrozen(w.toolbox())).toBe(true);
  });

  it("tool definitions leak no fixture data from any scenario", () => {
    for (const s of ds.data.scenarios) {
      const defs = JSON.stringify(createWorld(ds, s, new Recorder()).toolbox().toolDefs());
      const fx: any = s.pharmacy_fixture ?? s.clinic_fixture;
      const secrets: string[] = [];
      for (const p of fx.patients) {
        secrets.push(p.name, p.dob, ...(p.phone ? [p.phone] : []), ...p.authorized_contacts.map((c: any) => c.name));
        for (const rx of p.prescriptions ?? []) secrets.push(rx.rx_id);
      }
      for (const a of fx.appointments ?? []) secrets.push(a.appointment_id, a.slot_id);
      for (const slot of fx.open_slots ?? []) secrets.push(slot);
      for (const secret of secrets) expect(defs.includes(secret), `${s.id}: tool defs contain "${secret}"`).toBe(false);
    }
  });
});

describe("calendar parity with the Python validator", () => {
  it("TS and scripts/calendar_lib.py generate the identical slot grid", () => {
    const ds = loadDataset("scheduling").data;
    const ids = ds.providers!.map((p) => p.id);
    const ts = allSlots(ds.calendar!, ids);
    const py = JSON.parse(execFileSync("python", ["-c",
      "import json,sys; sys.path.insert(0,'scripts'); from calendar_lib import all_slots; " +
      "d=json.load(open('scheduling_call_scenarios.v1.json',encoding='utf-8')); " +
      "s=all_slots(d['calendar'],[p['id'] for p in d['providers']]); print(json.dumps([x for c in s for x in s[c]]))"],
      { cwd: REPO_ROOT, encoding: "utf8" }));
    expect(ts.length).toBe(4 * 11 * 26);                                     // 4 providers x 11 weekdays x 26 slots
    expect([...ts].sort()).toEqual([...py].sort());
  });
});
