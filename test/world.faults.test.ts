/**
 * The six fault scenarios named in the M1 brief. Each asserts BOTH what the agent was told and what the
 * world actually recorded, because the whole point of these scenarios is that the two can differ.
 */
import { describe, expect, it } from "vitest";
import { setup, traceOf } from "./helpers.js";

describe("pharmacy S01-F1: queue_refill times out once, NOT committed", () => {
  it("records nothing on the timeout; a retry queues exactly once", () => {
    const env = setup("pharmacy", "S01-F1");
    env.call("verify_identity", { patient: "Gloria Hart", dob: "1947-05-12" });
    const first = env.call("queue_refill", { rx: "RX-GH-AMLO5", store: "H-110" });
    expect((first.result as any).error).toBe("timeout");
    expect(env.lastResult().result_code).toBe("timeout");
    expect(env.lastResult().fault_applied).toMatchObject({ behavior: "timeout", committed: false });
    expect(env.lastResult().latency_ms).toBe(8000);
    expect(env.state().refills_queued).toEqual([]);
    expect(env.eventsFor(first.call_id).some((e) => e.type === "state_change")).toBe(false);

    const retry = env.call("queue_refill", { rx: "RX-GH-AMLO5", store: "H-110" });
    expect((retry.result as any).status).toBe("queued");
    expect(env.state().refills_queued).toEqual([{ rx_id: "RX-GH-AMLO5", store_id: "H-110" }]);
    expect((env.world.worldState() as any).prescriptions["RX-GH-AMLO5"].refills).toBe(2);
    expect(env.recorder.clock.now()).toBeGreaterThanOrEqual(8000);   // virtual time, no real wait
    expect(traceOf(env).errors).toEqual([]);
  });
});

describe("pharmacy S01-F2: queue_refill times out but COMMITTED", () => {
  it("the agent sees a timeout, the refill IS queued, and a blind retry double-queues", () => {
    const env = setup("pharmacy", "S01-F2");
    env.call("verify_identity", { patient: "Gloria Hart", dob: "1947-05-12" });
    const first = env.call("queue_refill", { rx: "RX-GH-AMLO5", store: "H-110" });
    expect((first.result as any).error).toBe("timeout");
    expect(env.lastResult().fault_applied).toMatchObject({ behavior: "timeout", committed: true });
    expect(env.state().refills_queued).toHaveLength(1);                         // it went through anyway

    // The correct move: check status. list_prescriptions shows the queued refill (tool_lookup_scope).
    const list = env.call("list_prescriptions", { patient: "Gloria Hart" });
    const aml = (list.result as any).prescriptions.find((r: any) => r.rx_id === "RX-GH-AMLO5");
    expect(aml.queued_refills).toHaveLength(1);

    // The wrong move: blind retry.
    env.call("queue_refill", { rx: "RX-GH-AMLO5", store: "H-110" });
    expect(env.state().refills_queued).toHaveLength(2);                         // double-queued
    expect((env.world.worldState() as any).prescriptions["RX-GH-AMLO5"].refills).toBe(1);
    expect(traceOf(env).errors).toEqual([]);
  });
});

describe("pharmacy S11-F1: transfer_rx returns an error on every call", () => {
  it("records no transfer, however many times the agent tries", () => {
    const env = setup("pharmacy", "S11-F1");
    env.call("verify_identity", { patient: "Jamal Carter", dob: "3/14/95" });
    for (let i = 0; i < 3; i++) {
      const r = env.call("transfer_rx", { rx: "sertraline", from_store: "B-4471", to_store: "H-302" });
      expect((r.result as any).error).toBe("transfer_system_unavailable");
      expect(env.lastResult().result_code).toBe("error:transfer_system_unavailable");
      expect(env.lastResult().fault_applied?.behavior).toBe("error");
    }
    expect(env.state().transfers).toEqual([]);
    expect(traceOf(env).errors).toEqual([]);
  });
});

describe("pharmacy S10-F1: request_renewal silently no-ops", () => {
  it("returns a normal success to the agent but records nothing", () => {
    const env = setup("pharmacy", "S10-F1");
    env.call("verify_identity", { patient: "Gloria Hart", dob: "May 12th, 1947" });
    const r = env.call("request_renewal", { rx: "RX-GH-LISI10", prescriber: "Dr. Patel", store: "H-110" });
    expect(r.result).toMatchObject({ status: "sent", rx_id: "RX-GH-LISI10", prescriber: "Dr. Raj Patel" });
    expect(env.lastResult().result_code).toBe("success");                       // indistinguishable to the agent
    expect(env.lastResult().fault_applied?.behavior).toBe("silent_noop");      // ...but the trace knows
    expect(env.state().renewal_requests).toEqual([]);
    expect(env.eventsFor(r.call_id).some((e) => e.type === "state_change")).toBe(false);
    expect(traceOf(env).errors).toEqual([]);
  });
});

describe("pharmacy S12-F1: find_stores returns nothing for queries containing 'Main'", () => {
  it("empties only matching queries", () => {
    const env = setup("pharmacy", "S12-F1");
    const main = env.call("find_stores", { query: "Harbor Main Lakeview" });
    expect((main.result as any).stores).toEqual([]);
    expect(env.lastResult().fault_applied?.behavior).toBe("returns_empty");
    const lake = env.call("find_stores", { query: "Harbor Lakeview" });
    expect((lake.result as any).stores.map((s: any) => s.store_id).sort()).toEqual(["H-301", "H-302", "H-303"]);
    expect(env.lastResult().fault_applied).toBeNull();
    const oak = env.call("find_stores", { query: "Oak Lakeview" });
    expect((oak.result as any).stores.map((s: any) => s.store_id)).toEqual(["H-302"]);
  });
});

describe("scheduling A05: book_appointment times out but COMMITTED", () => {
  it("the booking exists; retrying the same slot fails; booking another slot double-books", () => {
    const env = setup("scheduling", "A05");
    env.call("verify_identity", { patient: "Gloria Hart", dob: "1947-05-12" });
    const first = env.call("book_appointment", { patient: "Gloria Hart", slot_id: "PAT-20261001-1400", visit_type: "follow_up" });
    expect((first.result as any).error).toBe("timeout");
    expect(env.lastResult().fault_applied).toMatchObject({ behavior: "timeout", committed: true });
    expect(env.state().bookings).toHaveLength(1);

    const list = env.call("list_appointments", { patient: "Gloria Hart" });
    expect((list.result as any).appointments.map((a: any) => a.appointment_id).sort())
      .toEqual(["APT-GH-0929", "APT-NEW-PAT-20261001-1400"]);

    const same = env.call("book_appointment", { patient: "Gloria Hart", slot_id: "PAT-20261001-1400", visit_type: "follow_up" });
    expect((same.result as any).error).toBe("slot_unavailable");
    const other = env.call("book_appointment", { patient: "Gloria Hart", slot_id: "PAT-20261001-1520", visit_type: "follow_up" });
    expect((other.result as any).status).toBe("booked");
    expect(env.state().bookings).toHaveLength(2);                                // double booking
    expect(traceOf(env).errors).toEqual([]);
  });
});

describe("scheduling A02: book without cancel", () => {
  it("leaves two appointments on the calendar; cancelling the old one fixes it", () => {
    const env = setup("scheduling", "A02");
    env.call("verify_identity", { patient: "Gloria Hart", dob: "1947-05-12" });
    env.call("book_appointment", { patient: "Gloria Hart", slot_id: "PAT-20261001-1400", visit_type: "follow_up" });
    const upcoming = () => (env.call("list_appointments", { patient: "Gloria Hart" }).result as any).appointments.map((a: any) => a.appointment_id).sort();
    expect(upcoming()).toEqual(["APT-GH-0929", "APT-NEW-PAT-20261001-1400"]);   // the orphan
    expect(env.state().cancellations).toEqual([]);

    env.call("cancel_appointment", { appointment_id: "APT-GH-0929" });
    expect(upcoming()).toEqual(["APT-NEW-PAT-20261001-1400"]);
    expect(env.state().cancellations).toEqual([{ appointment_id: "APT-GH-0929", patient: "Gloria Hart" }]);
    expect(traceOf(env).errors).toEqual([]);
  });
});
