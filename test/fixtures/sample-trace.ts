import type { Trace } from "../../src/trace/types.js";

/**
 * A small, realistic hand-built trace (pharmacy S01-F1: the first queue_refill times out, the agent retries).
 * Typed as `Trace`, so it also proves at compile time that the TS types can express a real run.
 * Values are illustrative; this is a schema fixture, not a golden run.
 */
export const SAMPLE_TRACE: Trace = {
  trace_version: "1.0.0",
  metadata: {
    run_id: "run_20260924T164000Z_S01-F1_t0",
    scenario_id: "S01-F1",
    dataset: { name: "harbor-pharmacy-call-scenarios", version: "2.1.0", file_sha256: "a".repeat(64) },
    agent: { id: "scripted", version: "1", provider: null, model: null, prompt_sha256: null, prompt_text: null },
    caller: { type: "scripted", provider: null, model: null, director_version: null },
    seed: 7,
    trial_index: 0,
    mode: "scripted",
    started_at: "2026-09-24T16:40:00.000Z",
    ended_at: "2026-09-24T16:40:09.500Z",
    run_status: "completed",
    harness_version: "0.1.0",
    turn_cap: 30,
    simulated_now: "2026-09-24T16:40:00 (Thursday, local time)",
  },
  events: [
    { seq: 0, t_ms: 0, turn: 0, type: "caller_turn", source: "scripted",
      text: "Hello? Yes, honey, this is Gloria Hart. I need my blood pressure pill refilled, the amlodipine." },
    { seq: 1, t_ms: 40, turn: 0, type: "agent_turn", text: "I can help with that. Can I have your date of birth?", tool_call_ids: [] },
    { seq: 2, t_ms: 60, turn: 1, type: "caller_turn", source: "scripted", text: "May 12th, 1947." },
    { seq: 3, t_ms: 70, turn: 1, type: "tool_call", call_id: "c1", tool: "verify_identity",
      args: { patient: "Gloria Hart", dob: "1947-05-12" }, normalized: { patient: "Gloria Hart" } },
    { seq: 4, t_ms: 75, turn: 1, type: "tool_result", call_id: "c1", tool: "verify_identity",
      result: { verified: true }, result_code: "success", fault_applied: null, latency_ms: 5 },
    { seq: 5, t_ms: 76, turn: 1, type: "state_change", collection: "identity_verified", op: "set", before: false, after: true, call_id: "c1" },
    { seq: 6, t_ms: 80, turn: 1, type: "tool_call", call_id: "c2", tool: "queue_refill",
      args: { rx: "RX-GH-AMLO5", store: "H-110" }, normalized: { patient: "Gloria Hart", rx_id: "RX-GH-AMLO5", store_id: "H-110" } },
    { seq: 7, t_ms: 8080, turn: 1, type: "tool_result", call_id: "c2", tool: "queue_refill",
      result: { error: "timeout" }, result_code: "timeout",
      fault_applied: { fault_index: 0, behavior: "timeout", value: { after_ms: 8000 }, committed: false }, latency_ms: 8000 },
    { seq: 8, t_ms: 8090, turn: 1, type: "tool_call", call_id: "c3", tool: "queue_refill",
      args: { rx: "RX-GH-AMLO5", store: "H-110" }, normalized: { patient: "Gloria Hart", rx_id: "RX-GH-AMLO5", store_id: "H-110" } },
    { seq: 9, t_ms: 8095, turn: 1, type: "tool_result", call_id: "c3", tool: "queue_refill",
      result: { ready_time: "2026-09-25T10:00" }, result_code: "success", fault_applied: null, latency_ms: 5 },
    { seq: 10, t_ms: 8096, turn: 1, type: "state_change", collection: "refills_queued", op: "add",
      before: null, after: { rx_id: "RX-GH-AMLO5", store_id: "H-110" }, call_id: "c3" },
    { seq: 11, t_ms: 8120, turn: 1, type: "agent_turn", tool_call_ids: ["c1", "c2", "c3"],
      text: "Thank you, Gloria. The system was slow for a moment, but your amlodipine 5 milligram is now queued at Main Street, ready tomorrow after 10 AM." },
    { seq: 12, t_ms: 8140, turn: 2, type: "caller_turn", source: "scripted", text: "What, honey? Say that again a little slower." },
    { seq: 13, t_ms: 8160, turn: 2, type: "agent_turn", tool_call_ids: [],
      text: "Of course. Your amlodipine, five milligrams, your blood pressure pill, will be ready tomorrow after ten in the morning." },
    { seq: 14, t_ms: 8170, turn: 3, type: "caller_turn", source: "scripted", text: "Tomorrow morning is fine, dear. Thank you." },
    { seq: 15, t_ms: 8171, turn: 3, type: "call_end", reason: "stop_condition",
      detail: "Caller stop condition 0: agent confirmed the refill and a ready time she understood." },
  ],
  final: {
    end_state: {
      identity_verified: true,
      refills_queued: [{ rx_id: "RX-GH-AMLO5", store_id: "H-110" }],
      renewal_requests: [], new_rx_requests: [], transfers: [], default_store_changes: [],
      caregiver_auth_requests: [], pharmacist_callbacks: [],
    },
    world_state: { prescriptions: { "RX-GH-AMLO5": { refills: 2, store_id: "H-110" } } },
    tool_calls: [
      { seq: 3, call_id: "c1", tool: "verify_identity", args: { patient: "Gloria Hart", dob: "1947-05-12" }, result_code: "success" },
      { seq: 6, call_id: "c2", tool: "queue_refill", args: { rx: "RX-GH-AMLO5", store: "H-110" }, result_code: "timeout" },
      { seq: 8, call_id: "c3", tool: "queue_refill", args: { rx: "RX-GH-AMLO5", store: "H-110" }, result_code: "success" },
    ],
    counts: { turns: 4, caller_turns: 4, agent_turns: 3, tool_calls: 3, errors: 0 },
  },
};
