import { describe, expect, it } from "vitest";
import { loadTraceSchema, validateTrace } from "../src/trace/validate.js";
import {
  CALL_END_REASONS, CALLER_TYPES, DATASET_NAMES, ERROR_SOURCES, EVENT_TYPES, FAULT_BEHAVIORS, HANDOFF_TARGETS,
  HANDOFF_TOOLS, RUN_MODES, RUN_STATUSES, STATE_OPS, TRACE_VERSION, TRIGGER_EVIDENCE_KINDS, VALIDITY_CHECK_NAMES,
  VALIDITY_STATUSES, type Trace,
} from "../src/trace/types.js";
import { SAMPLE_TRACE } from "./fixtures/sample-trace.js";

const schema = loadTraceSchema() as any;
const defs = schema.$defs;
const clone = (): Trace => structuredClone(SAMPLE_TRACE);
const sorted = (xs: readonly string[]) => [...xs].sort();

describe("trace.schema.json", () => {
  it("compiles under Ajv strict mode and accepts the sample trace", () => {
    const r = validateTrace(SAMPLE_TRACE);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("has exactly the same enums as the TypeScript constants (no drift)", () => {
    const pairs: [string, unknown, readonly string[]][] = [
      ["dataset.name", defs.metadata.properties.dataset.properties.name.enum, DATASET_NAMES],
      ["caller.type", defs.metadata.properties.caller.properties.type.enum, CALLER_TYPES],
      ["mode", defs.metadata.properties.mode.enum, RUN_MODES],
      ["run_status", defs.metadata.properties.run_status.enum, RUN_STATUSES],
      ["event.type", defs.event.properties.type.enum, EVENT_TYPES],
      ["caller_turn.source", defs.caller_turn.properties.source.enum, CALLER_TYPES],
      ["call_end.reason", defs.call_end.properties.reason.enum, CALL_END_REASONS],
      ["applied_fault.behavior", defs.applied_fault.properties.behavior.enum, FAULT_BEHAVIORS],
      ["state_change.op", defs.state_change.properties.op.enum, STATE_OPS],
      ["error.source", defs.error.properties.source.enum, ERROR_SOURCES],
      ["handoff.to", defs.handoff.properties.to.enum, HANDOFF_TARGETS],
      ["tool_result handoff tools", defs.tool_result.if.properties.tool.enum, HANDOFF_TOOLS],
      ["trigger_evidence.kind", defs.trigger_evidence.oneOf.map((o: any) => o.properties.kind.const), TRIGGER_EVIDENCE_KINDS],
      ["validity.name", defs.validity.properties.checks.items.properties.name.enum, VALIDITY_CHECK_NAMES],
      ["validity.status", defs.validity.properties.checks.items.properties.status.enum, VALIDITY_STATUSES],
    ];
    for (const [label, fromSchema, fromTs] of pairs) {
      expect(sorted(fromSchema as string[]), label).toEqual(sorted(fromTs));
    }
    expect(schema.properties.trace_version.const).toBe(TRACE_VERSION);
  });

  it("covers every event type with its own definition", () => {
    for (const t of EVENT_TYPES) expect(defs[t], t).toBeDefined();
  });

  it("the fault behaviors match both datasets' tool_fault_types", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["pharmacy_call_scenarios.v2.json", "scheduling_call_scenarios.v1.json"]) {
      const ds = JSON.parse(readFileSync(f, "utf8"));
      const behaviors = Object.keys(ds.tool_fault_types).filter((k) => !k.startsWith("_"));
      expect(sorted(behaviors), f).toEqual(sorted(FAULT_BEHAVIORS));
    }
  });

  // --- rejections: each mutation must make the trace invalid -------------------------------------------
  const rejections: [string, (t: any) => void][] = [
    ["missing metadata.run_status", (t) => { delete t.metadata.run_status; }],
    ["unknown run_status", (t) => { t.metadata.run_status = "graded"; }],
    ["unknown event type", (t) => { t.events[0].type = "narration"; }],
    ["extra field on caller_turn", (t) => { t.events[0].score = 1; }],
    ["tool_call without normalized", (t) => { delete t.events[3].normalized; }],
    ["malformed result_code", (t) => { t.events[4].result_code = "ok"; }],
    ["bad dataset hash", (t) => { t.metadata.dataset.file_sha256 = "abc"; }],
    ["negative trial index", (t) => { t.metadata.trial_index = -1; }],
    ["timeout fault with unknown behavior", (t) => { t.events[7].fault_applied.behavior = "explode"; }],
    ["successful flag_callback without handoff", (t) => {
      t.events.push({ seq: 16, t_ms: 9000, turn: 3, type: "tool_result", call_id: "c4", tool: "flag_callback",
        result: { ok: true }, result_code: "success", fault_applied: null, latency_ms: 1 });
    }],
    ["call_end transfer without handoff", (t) => { t.events[15].reason = "transfer"; }],
    ["director_decision with free-form evidence", (t) => {
      t.events.push({ seq: 16, t_ms: 9000, turn: 3, type: "director_decision", unlocked_disclosures: [], move_fired: null,
        trigger_evidence: [{ kind: "gut_feeling" }] });
    }],
    ["end_state collection that is not a list", (t) => { t.final.end_state.refills_queued = "one"; }],
    ["validity check with unknown name", (t) => {
      t.validity = { computed_at: "2026-09-24T16:41:00Z", checks: [{ name: "agent_quality", status: "pass", details: [] }] };
    }],
  ];
  for (const [label, mutate] of rejections) {
    it(`rejects: ${label}`, () => {
      const t = clone();
      mutate(t);
      expect(validateTrace(t).valid).toBe(false);
    });
  }

  // --- acceptances that exercise optional parts ---------------------------------------------------------
  it("accepts a transfer with its handoff payload, a director decision and validity checks", () => {
    const t: any = clone();
    const handoff = { to: "nurse_line", reason: "cardiac_symptoms", via_tool: "transfer_to_nurse_line",
      context_passed: { patient: "Tess Morgan", summary: "chest tightness, more ankle swelling, 4 lb gain" } };
    t.events.splice(15, 1,
      { seq: 15, t_ms: 8171, turn: 3, type: "director_decision", unlocked_disclosures: [{ index: 3, fact: "Up about 4 lb since Sunday" }],
        move_fired: { index: 1, say: "It's always like that." },
        trigger_evidence: [
          { kind: "tool_event", seq: 4, description: "verify_identity succeeded" },
          { kind: "llm_check", question: "Did the agent raise concern about her symptoms?", model: "caller-model",
            prompt_sha256: "b".repeat(64), raw_output: "{\"verdict\": true}", verdict: true },
        ] },
      { seq: 16, t_ms: 8180, turn: 3, type: "tool_call", call_id: "c4", tool: "transfer_to_nurse_line",
        args: { patient: "Tess Morgan", reason: "cardiac_symptoms" }, normalized: { patient: "Tess Morgan" } },
      { seq: 17, t_ms: 8190, turn: 3, type: "tool_result", call_id: "c4", tool: "transfer_to_nurse_line",
        result: { transferred: true }, result_code: "success", fault_applied: null, latency_ms: 10, handoff },
      { seq: 18, t_ms: 8191, turn: 3, type: "call_end", reason: "transfer", detail: "Agent transferred the caller to the nurse line.", handoff },
    );
    t.validity = { computed_at: "2026-09-24T16:41:00Z", checks: [
      { name: "trace_integrity", status: "pass", details: [] },
      { name: "disclosure_leak", status: "needs_review", details: ["turn 2: '4 lb' may match an only_if_asked fact"] },
    ] };
    const r = validateTrace(t);
    expect(r.errors).toEqual([]);
  });
});
