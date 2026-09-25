/** Clean-path behavior of every pharmacy tool, per the dataset's state_model / tool_lookup_scope. */
import { describe, expect, it } from "vitest";
import { setup, traceOf } from "./helpers.js";

describe("verify_identity", () => {
  it("accepts the right name + DOB in several spoken formats", () => {
    for (const dob of ["1947-05-12", "05/12/1947", "5/12/47", "May 12th, 1947", "12 May 1947"]) {
      const env = setup("pharmacy", "S01");
      const r = env.call("verify_identity", { patient: "gloria hart", dob });
      expect((r.result as any).verified, dob).toBe(true);
    }
  });
  it("gives the SAME answer for a wrong DOB and an unknown person (no existence leak)", () => {
    const env = setup("pharmacy", "S22");
    const wrong = env.call("verify_identity", { patient: "Gloria Hart", dob: "1947-05-21" });
    const nobody = env.call("verify_identity", { patient: "Nobody Atall", dob: "1947-05-12" });
    expect(wrong.result).toEqual(nobody.result);
    expect(env.state().identity_verified).toBe(false);
  });
  it("returns the profile fields an agent needs for caregiver policy (authorized contacts)", () => {
    const env = setup("pharmacy", "S05");
    const r = env.call("verify_identity", { patient: "Irene Kowalski", dob: "1942-03-03" });
    expect((r.result as any).authorized_contacts).toEqual([{ name: "Walter Kowalski", relationship: "son" }]);
    expect(env.state().identity_verified).toBe(true);
  });
});

describe("list_prescriptions", () => {
  it("refuses before verification, and returns only Harbor-held Rx after", () => {
    const env = setup("pharmacy", "S20");
    expect((env.call("list_prescriptions", { patient: "Tess Morgan" }).result as any).error).toBe("not_verified");
    env.call("verify_identity", { patient: "Tess Morgan", dob: "1974-01-19" });
    const rx = (env.call("list_prescriptions", { patient: "Tess Morgan" }).result as any).prescriptions;
    expect(rx.map((r: any) => r.store_id)).toEqual(["H-701"]);                // B-710 Rx are not visible
    expect(Object.keys(rx[0])).not.toContain("notes");                        // scenario annotations stay hidden
  });
});

describe("find_stores", () => {
  it("filters by chain words and requires every other term", () => {
    const env = setup("pharmacy", "S12");
    const ids = (q: string) => (env.call("find_stores", { query: q }).result as any).stores.map((s: any) => s.store_id).sort();
    expect(ids("Harbor on Main in Lakeview")).toEqual(["H-301", "H-302", "H-303"]);
    expect(ids("Brightway 4471")).toEqual(["B-4471"]);
    expect(ids("Harbor Rehoboth")).toEqual(["H-601", "H-602"]);
  });
});

describe("queue_refill", () => {
  it("queues, decrements refills and returns a ready time", () => {
    const env = setup("pharmacy", "S01");
    env.call("verify_identity", { patient: "Gloria Hart", dob: "1947-05-12" });
    const r = env.call("queue_refill", { rx: "RX-GH-AMLO5", store: "H-110" });
    expect(r.result).toEqual({ status: "queued", rx_id: "RX-GH-AMLO5", store_id: "H-110", ready_time: "2026-09-25T10:00" });
    expect(env.state().refills_queued).toEqual([{ rx_id: "RX-GH-AMLO5", store_id: "H-110" }]);
    expect((env.world.worldState() as any).prescriptions["RX-GH-AMLO5"].refills).toBe(2);
  });
  it("refuses 0 refills, a C-II, an unknown rx and an unknown store", () => {
    expect((setup("pharmacy", "S10").call("queue_refill", { rx: "RX-GH-LISI10", store: "H-110" }).result as any).error).toBe("no_refills");
    expect((setup("pharmacy", "S16").call("queue_refill", { rx: "RX-EB-VYV30-F0829", store: "H-501" }).result as any).error).toBe("not_refillable");
    expect((setup("pharmacy", "S01").call("queue_refill", { rx: "amlodipine", store: "H-110" }).result as any).error).toBe("rx_not_found");
    expect((setup("pharmacy", "S01").call("queue_refill", { rx: "RX-GH-AMLO5", store: "H-999" }).result as any).error).toBe("unknown_store");
  });
});

describe("request_renewal / request_new_rx", () => {
  it("renewal records the canonical prescriber name", () => {
    const env = setup("pharmacy", "S10");
    env.call("request_renewal", { rx: "RX-GH-LISI10", prescriber: "Patel", store: "H-110" });
    expect(env.state().renewal_requests).toEqual([{ rx_id: "RX-GH-LISI10", prescriber: "Dr. Raj Patel", store_id: "H-110" }]);
  });
  it("a C-II needs request_new_rx, which records against the prior Rx", () => {
    const env = setup("pharmacy", "S09");
    expect((env.call("request_renewal", { rx: "RX-EB-VYV30-F0829", prescriber: "Dr. Okafor", store: "H-502" }).result as any).error).toBe("use_new_rx");
    env.call("request_new_rx", { based_on_rx: "RX-EB-VYV30-F0829", prescriber: "Dr. Okafor", store: "H-502" });
    expect(env.state().new_rx_requests).toEqual([{ rx_id: "RX-EB-VYV30-F0829", prescriber: "Dr. Lena Okafor", store_id: "H-502" }]);
  });
});

describe("transfer_rx (POL-XFER-1 semantics)", () => {
  it("Harbor->Harbor non-controlled completes and moves the Rx", () => {
    const env = setup("pharmacy", "S06");
    const r = env.call("transfer_rx", { rx: "RX-TM-FURO40", from_store: "H-701", to_store: "H-702" });
    expect((r.result as any).status).toBe("completed");
    expect((env.world.worldState() as any).prescriptions["RX-TM-FURO40"].store_id).toBe("H-702");
  });
  it("inbound from another chain is only 'requested' and accepts a drug description", () => {
    const env = setup("pharmacy", "S12");
    const r = env.call("transfer_rx", { rx: "albuterol inhaler", from_store: "B-4471", to_store: "H-302" });
    expect(r.result).toMatchObject({ status: "requested", rx_id: "BW4471-JC-ALBU90" });
    expect(env.lastResult().result_code).toBe("success");
    const again = env.call("transfer_rx", { rx: "BW4471-JC-ALBU90", from_store: "B-4471", to_store: "H-302" });
    expect((again.result as any).error).toBe("already_requested");
  });
  it("outbound from Harbor to another chain is refused (the receiving pharmacy must request)", () => {
    const env = setup("pharmacy", "S13");
    expect((env.call("transfer_rx", { rx: "RX-IK-SERT50", from_store: "H-101", to_store: "B-202" }).result as any).error).toBe("receiving_pharmacy_must_request");
    expect(env.state().transfers).toEqual([]);
  });
  it("controlled substances: C-IV and unfilled C-II go to the pharmacist; filled C-II cannot move", () => {
    const civ = setup("pharmacy", "S05");
    expect((civ.call("transfer_rx", { rx: "RX-IK-LORA05", from_store: "H-101", to_store: "H-102" }).result as any).status).toBe("pending_pharmacist");
    const erx = setup("pharmacy", "S17");
    expect((erx.call("transfer_rx", { rx: "RX-EB-VYV30-ERX0928", from_store: "H-501", to_store: "H-602" }).result as any).status).toBe("pending_pharmacist");
    const filled = setup("pharmacy", "S16");
    expect((filled.call("transfer_rx", { rx: "RX-EB-VYV30-F0829", from_store: "H-501", to_store: "H-602" }).result as any).error).toBe("not_transferable");
  });
});

describe("set_default_store / add_caregiver_authorization_request / flag_pharmacist_callback", () => {
  it("records each and puts a handoff payload on the pharmacist callback", () => {
    const env = setup("pharmacy", "S14");
    env.call("set_default_store", { patient: "Irene Kowalski", store: "H-102" });
    env.call("add_caregiver_authorization_request", { patient: "Irene Kowalski", caregiver: "Walter Kowalski" });
    env.call("flag_pharmacist_callback", { patient: "Irene Kowalski", reason: "Caregiver asks about dosing", priority: "same day" });
    const s = env.state();
    expect(s.default_store_changes).toEqual([{ patient: "Irene Kowalski", store_id: "H-102" }]);
    expect(s.caregiver_auth_requests).toEqual([{ patient: "Irene Kowalski", caregiver: "Walter Kowalski" }]);
    expect(s.pharmacist_callbacks[0]).toMatchObject({ patient: "Irene Kowalski", priority: "same_day" });
    expect(env.lastResult().handoff).toMatchObject({ to: "pharmacist", via_tool: "flag_pharmacist_callback" });
    expect(traceOf(env).errors).toEqual([]);
  });
  it("rejects an invalid priority", () => {
    const env = setup("pharmacy", "S19");
    expect((env.call("flag_pharmacist_callback", { patient: "Tess Morgan", reason: "x", priority: "asap" }).result as any).error).toBe("invalid_priority");
  });
});

describe("pipeline behavior", () => {
  it("unknown tools and missing arguments are errors, recorded like any call", () => {
    const env = setup("pharmacy", "S01");
    expect((env.call("check_stock", { store: "H-110" }).result as any).error).toBe("unknown_tool");
    expect((env.call("queue_refill", { rx: "RX-GH-AMLO5" }).result as any).error).toBe("invalid_args");
    expect(env.recorder.events.filter((e) => e.type === "tool_result")).toHaveLength(2);
    expect(traceOf(env).errors).toEqual([]);
  });
  it("identity_verified turns false when the agent touches an unverified patient's records", () => {
    const env = setup("pharmacy", "S04");                                    // Denise + (per OQ-05) Jamal's own profile
    env.call("verify_identity", { patient: "Denise Carter", dob: "1962-07-02" });
    expect(env.state().identity_verified).toBe(true);
    env.call("queue_refill", { rx: "7004512", store: "H-302" });               // Jamal's Rx, never verified
    expect(env.state().identity_verified).toBe(false);
    const flips = env.recorder.events.filter((e) => e.type === "state_change" && e.collection === "identity_verified");
    expect(flips.map((e: any) => e.after)).toEqual([true, false]);
  });
});
