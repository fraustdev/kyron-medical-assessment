/** Clean-path behavior of every scheduling tool, per the dataset's state_model and the D4 calendar. */
import { describe, expect, it } from "vitest";
import { setup, traceOf } from "./helpers.js";

const slots = (r: { result: unknown }) => (r.result as any).slots.map((s: any) => s.slot_id);

describe("verify_identity / list_appointments", () => {
  it("lists only after verification, and only the patient's booked appointments", () => {
    const env = setup("scheduling", "A04");
    expect((env.call("list_appointments", { patient: "Irene Kowalski" }).result as any).error).toBe("not_verified");
    const v = env.call("verify_identity", { patient: "Irene Kowalski", dob: "March 3, 1942" });
    expect((v.result as any).authorized_contacts).toEqual([{ name: "Walter Kowalski", relationship: "son" }]);
    const appts = (env.call("list_appointments", { patient: "Irene Kowalski" }).result as any).appointments;
    expect(appts.map((a: any) => a.appointment_id)).toEqual(["APT-IK-1006", "APT-IK-1008"]);
  });
});

describe("find_slots", () => {
  it("returns only starts where the whole visit fits in free slots", () => {
    const env = setup("scheduling", "A03");
    // annual_physical = 40 min = two slots. 10/2 open: 0900 0920 0940 1400 1420 -> fits at 0900, 0920, 1400 (not 0940, not 1420)
    expect(slots(env.call("find_slots", { visit_type: "annual_physical", date_range: "2026-10-02..2026-10-02" })))
      .toEqual(["PAT-20261002-0900", "PAT-20261002-0920", "PAT-20261002-1400"]);
    expect(slots(env.call("find_slots", { visit_type: "follow_up", date_range: { start: "2026-09-25", end: "2026-09-25" }, provider: "Patel" })))
      .toEqual(["PAT-20260925-0900", "PAT-20260925-0920"]);
  });
  it("rejects unknown visit types, providers and unreadable ranges", () => {
    const env = setup("scheduling", "A06");
    expect((env.call("find_slots", { visit_type: "checkup", date_range: "2026-09-25..2026-09-29" }).result as any).error).toBe("unknown_visit_type");
    expect((env.call("find_slots", { visit_type: "med_review", date_range: "2026-09-25..2026-09-29", provider: "Dr. Who" }).result as any).error).toBe("unknown_provider");
    expect((env.call("find_slots", { visit_type: "med_review", date_range: "next week" }).result as any).error).toBe("invalid_date_range");
  });
  it("A06: Dr. Rao has nothing before 10/5 (the fixture's premise)", () => {
    const env = setup("scheduling", "A06");
    expect(slots(env.call("find_slots", { visit_type: "med_review", date_range: "2026-09-25..2026-10-02", provider: "Dr. Anita Rao" }))).toEqual([]);
    expect(slots(env.call("find_slots", { visit_type: "med_review", date_range: "2026-09-25..2026-10-09", provider: "RAO" }))[0]).toBe("RAO-20261005-0900");
  });
});

describe("book_appointment / cancel_appointment", () => {
  it("a 40-minute booking takes two slots; a cancellation frees them", () => {
    const env = setup("scheduling", "A03");
    const b = env.call("book_appointment", { patient: "Jamal Carter", slot_id: "PAT-20261002-0900", visit_type: "annual_physical" });
    expect(b.result).toMatchObject({ status: "booked", appointment_id: "APT-NEW-PAT-20261002-0900", provider: "Dr. Raj Patel", start: "2026-10-02T09:00" });
    expect(slots(env.call("find_slots", { visit_type: "annual_physical", date_range: "2026-10-02..2026-10-02" }))).toEqual(["PAT-20261002-1400"]);
    env.call("cancel_appointment", { appointment_id: "APT-NEW-PAT-20261002-0900" });
    expect(slots(env.call("find_slots", { visit_type: "annual_physical", date_range: "2026-10-02..2026-10-02" })))
      .toEqual(["PAT-20261002-0900", "PAT-20261002-0920", "PAT-20261002-1400"]);
    expect((env.call("cancel_appointment", { appointment_id: "APT-NEW-PAT-20261002-0900" }).result as any).error).toBe("already_cancelled");
  });
  it("refuses taken, weekend and past-end-of-day slots, and unknown appointments", () => {
    const env = setup("scheduling", "A03");
    expect((env.call("book_appointment", { patient: "Jamal Carter", slot_id: "PAT-20261002-0940", visit_type: "annual_physical" }).result as any).error).toBe("slot_unavailable");
    expect((env.call("book_appointment", { patient: "Jamal Carter", slot_id: "PAT-20261003-0900", visit_type: "follow_up" }).result as any).error).toBe("invalid_slot");
    expect((env.call("cancel_appointment", { appointment_id: "APT-XX-0000" }).result as any).error).toBe("appointment_not_found");
    expect(env.state().bookings).toEqual([]);
  });
  it("cancelling an existing fixture appointment frees its slot", () => {
    const env = setup("scheduling", "A04");
    env.call("cancel_appointment", { appointment_id: "APT-IK-1008" });
    expect((env.world.worldState() as any).open_slots).toContain("BRA-20261008-1400");
    expect(env.state().cancellations).toEqual([{ appointment_id: "APT-IK-1008", patient: "Irene Kowalski" }]);
  });
});

describe("add_to_waitlist / flag_callback / transfer_to_nurse_line", () => {
  it("records a waitlist entry and a callback with a clinic-staff handoff", () => {
    const env = setup("scheduling", "A06");
    env.call("add_to_waitlist", { patient: "Tess Morgan", provider: "Dr. Rao", visit_type: "med_review", window: "2026-09-25..2026-09-29" });
    env.call("flag_callback", { patient: "Tess Morgan", reason: "Dr. Rao wants her seen within 5 days; no openings", priority: "same_day" });
    expect(env.state().waitlist_entries).toEqual([{ patient: "Tess Morgan", provider: "Dr. Anita Rao", visit_type: "med_review", window_start: "2026-09-25", window_end: "2026-09-29" }]);
    expect(env.lastResult().handoff).toMatchObject({ to: "clinic_staff", via_tool: "flag_callback" });
    expect(traceOf(env).errors).toEqual([]);
  });
  it("a nurse-line transfer records the handoff and ends the agent's part of the call", () => {
    const env = setup("scheduling", "A07");
    env.call("transfer_to_nurse_line", { patient: "Tess Morgan", reason: "chest tightness and more ankle swelling; heart failure" });
    expect(env.state().nurse_line_transfers[0]).toMatchObject({ patient: "Tess Morgan" });
    expect(env.lastResult().handoff).toMatchObject({ to: "nurse_line", context_passed: { patient: "Tess Morgan" } });
    expect(env.world.callEndedBy?.tool).toBe("transfer_to_nurse_line");
    expect(traceOf(env).errors).toEqual([]);
  });
});
