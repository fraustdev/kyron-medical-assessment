/**
 * Harbor Family Medicine mock tools. Semantics follow scheduling_call_scenarios.v1.json (state_model,
 * tool_lookup_scope, decisions D3/D4): the calendar is ground truth, a slot is free only if it is in the
 * fixture's open_slots (and not taken during the call), and there is NO atomic reschedule tool.
 */
import type { NormalizedFields } from "../trace/types.js";
import { addRecord, BaseWorld, err, type Handler, type ToolDef, type ToolOutcome } from "./base.js";
import { isValidSlot, occupiedSlots, parseSlot, slotStartIso } from "./calendar.js";
import type { Appointment, CalendarSpec, ClinicPatient, LoadedDataset, Provider, Scenario } from "./dataset.js";
import type { Recorder } from "./recorder.js";
import { normName, parseDate, parseDateRange, reasonTag } from "./util.js";

const PRIORITIES = ["routine", "same_day", "urgent"] as const;
const MAX_SLOTS_RETURNED = 20;

interface LiveAppointment extends Omit<Appointment, "status"> { status: "booked" | "cancelled" }

export class SchedulingWorld extends BaseWorld {
  private readonly patients: ClinicPatient[];
  private readonly providers: Provider[];
  private readonly cal: CalendarSpec;
  private readonly visitTypes: Record<string, { minutes: number }>;
  private readonly open: Set<string>;
  private readonly appointments: LiveAppointment[];
  protected readonly handlers: Record<string, Handler>;

  constructor(dataset: LoadedDataset, scenario: Scenario, recorder: Recorder) {
    super(dataset, scenario, recorder);
    if (!scenario.clinic_fixture) throw new Error(`${scenario.id} has no clinic_fixture`);
    const fx = structuredClone(scenario.clinic_fixture);
    this.patients = fx.patients;
    this.providers = dataset.data.providers ?? [];
    this.cal = dataset.data.calendar!;
    this.visitTypes = dataset.data.visit_types ?? {};
    this.open = new Set(fx.open_slots);
    this.appointments = fx.appointments.map((a) => ({ ...a }));
    this.handlers = this.buildHandlers();
  }

  // ------------------------------------------------------------------ lookups
  private names(): string[] { return this.patients.map((p) => p.name); }
  private provider(x: unknown): Provider | null {
    if (typeof x !== "string" || !x.trim()) return null;
    const byId = this.providers.find((p) => p.id === x.trim().toUpperCase());
    if (byId) return byId;
    const n = normName(x);
    return this.providers.find((p) => normName(p.name) === n || normName(p.name).split(" ").pop() === n.split(" ").pop()) ?? null;
  }
  private providerOfSlot(slot: string): Provider | null {
    const p = parseSlot(slot);
    return p ? this.providers.find((x) => x.id === p.provider) ?? null : null;
  }
  private appointment(id: unknown): LiveAppointment | null {
    if (typeof id !== "string") return null;
    return this.appointments.find((a) => a.appointment_id.toLowerCase() === id.trim().toLowerCase()) ?? null;
  }
  private fits(slot: string, visitType: string): string[] | null {
    const need = occupiedSlots(this.cal, slot, this.visitTypes[visitType]!.minutes);
    return need && need.every((s) => this.open.has(s)) ? need : null;
  }

  // ------------------------------------------------------------------ tools
  private buildHandlers(): Record<string, Handler> {
    const desc = (name: string) => this.dataset.data.agent_context.tools.find((t) => t.startsWith(`${name}(`)) ?? name;
    const def = (name: string, params: ToolDef["params"]): ToolDef => ({ name, description: desc(name), params });
    const P = (name: string, description: string, required = true) => ({ name, type: "string" as const, required, description });
    const patientNorm = (a: Record<string, unknown>): NormalizedFields => ({ patient: this.resolvePatient(a.patient, this.names()) ?? (a.patient as string ?? null) });
    const vt = Object.keys(this.visitTypes).join(" | ");

    return {
      verify_identity: {
        def: def("verify_identity", [P("patient", "Patient full name"), P("dob", "Patient date of birth"), P("second_factor", "Address or phone, if needed", false)]),
        write: false, normalize: patientNorm, run: (a) => this.verifyIdentity(a),
      },
      list_appointments: {
        def: def("list_appointments", [P("patient", "Verified patient's full name")]),
        write: false, normalize: patientNorm, run: (a) => this.listAppointments(a),
      },
      find_slots: {
        def: def("find_slots", [P("visit_type", vt), P("date_range", "Dates to search, as YYYY-MM-DD..YYYY-MM-DD"), P("provider", "Doctor's name (optional)", false)]),
        write: false,
        normalize: (a) => ({ provider: this.provider(a.provider)?.name ?? (a.provider as string ?? null), visit_type: a.visit_type as string ?? null }),
        run: (a) => this.findSlots(a),
      },
      book_appointment: {
        def: def("book_appointment", [P("patient", "Patient's full name"), P("slot_id", "slot_id from find_slots"), P("visit_type", vt)]),
        write: true,
        normalize: (a) => ({ ...patientNorm(a), slot_id: a.slot_id as string ?? null, provider: typeof a.slot_id === "string" ? this.providerOfSlot(a.slot_id)?.name ?? null : null, visit_type: a.visit_type as string ?? null }),
        run: (a) => this.book(a),
      },
      cancel_appointment: {
        def: def("cancel_appointment", [P("appointment_id", "appointment_id from list_appointments")]),
        write: true,
        normalize: (a) => { const ap = this.appointment(a.appointment_id); return { patient: ap?.patient ?? null, appointment_id: ap?.appointment_id ?? (a.appointment_id as string), provider: ap?.provider ?? null }; },
        run: (a) => this.cancel(a),
      },
      add_to_waitlist: {
        def: def("add_to_waitlist", [P("patient", "Patient's full name"), P("provider", "Doctor's name"), P("visit_type", vt), P("window", "Acceptable dates, as YYYY-MM-DD..YYYY-MM-DD")]),
        write: true,
        normalize: (a) => ({ ...patientNorm(a), provider: this.provider(a.provider)?.name ?? (a.provider as string ?? null), visit_type: a.visit_type as string ?? null }),
        run: (a) => this.waitlist(a),
      },
      flag_callback: {
        def: def("flag_callback", [P("patient", "Patient's full name"), P("reason", "Why the clinic should call back, with the relevant context"), P("priority", "routine | same_day | urgent")]),
        write: true, normalize: patientNorm, run: (a) => this.callback(a),
      },
      transfer_to_nurse_line: {
        def: def("transfer_to_nurse_line", [P("patient", "Patient's full name"), P("reason", "What the nurse needs to know (symptoms, context)")]),
        write: true, normalize: patientNorm, run: (a) => this.nurse(a),
      },
    };
  }

  private verifyIdentity(a: Record<string, unknown>): ToolOutcome {
    const dob = parseDate(a.dob);
    const name = this.resolvePatient(a.patient, this.names());
    const p = name ? this.patients.find((x) => x.name === name) : undefined;
    if (!p || !dob || dob !== p.dob) return err("not_verified", "The name and date of birth do not match our records.");
    return {
      code: "success", mutations: [], verified: p.name, touched: [p.name],
      result: {
        verified: true, patient: p.name, provider_of_record: p.provider_of_record,
        authorized_contacts: p.authorized_contacts.map((c) => ({ name: c.name, relationship: c.relationship })),
        restricted_contacts: p.restricted_contacts.map((c) => ({ name: c.name })),
      },
    };
  }

  private listAppointments(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name || !this.isVerified(name)) return err("not_verified", "Verify the patient's identity first.");
    const upcoming = this.appointments.filter((x) => x.patient === name && x.status === "booked")
      .map(({ appointment_id, provider, start, visit_type, slot_id }) => ({ appointment_id, provider, start, visit_type, slot_id }));
    return { code: "success", mutations: [], touched: [name], result: { patient: name, appointments: upcoming } };
  }

  private findSlots(a: Record<string, unknown>): ToolOutcome {
    const visitType = String(a.visit_type);
    if (!this.visitTypes[visitType]) return err("unknown_visit_type", `visit_type must be one of: ${Object.keys(this.visitTypes).join(", ")}.`);
    const range = parseDateRange(a.date_range);
    if (!range) return err("invalid_date_range", "date_range must look like YYYY-MM-DD..YYYY-MM-DD.");
    let prov: Provider | null = null;
    if (a.provider !== undefined && a.provider !== null && a.provider !== "") {
      prov = this.provider(a.provider);
      if (!prov) return err("unknown_provider", "No clinic provider by that name.");
    }
    const slots = [...this.open].sort().filter((s) => {
      const p = parseSlot(s)!;
      return p.date >= range.start && p.date <= range.end && (!prov || p.provider === prov.id) && this.fits(s, visitType) !== null;
    }).slice(0, MAX_SLOTS_RETURNED).map((s) => ({ slot_id: s, provider: this.providerOfSlot(s)!.name, start: slotStartIso(s) }));
    return { code: "success", mutations: [], result: { visit_type: visitType, slots } };
  }

  private book(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name) return err("patient_not_found", "No matching patient.");
    const visitType = String(a.visit_type);
    if (!this.visitTypes[visitType]) return err("unknown_visit_type", `visit_type must be one of: ${Object.keys(this.visitTypes).join(", ")}.`);
    const slot = String(a.slot_id).trim().toUpperCase();
    if (!isValidSlot(this.cal, this.providers.map((p) => p.id), slot)) return err("invalid_slot", "That slot_id is not on the clinic calendar.");
    const need = this.fits(slot, visitType);
    if (!need) return err("slot_unavailable", "That time is not available for this visit type.");
    const prov = this.providerOfSlot(slot)!;
    const appt: LiveAppointment = { appointment_id: `APT-NEW-${slot}`, patient: name, provider: prov.name, slot_id: slot, start: slotStartIso(slot), visit_type: visitType, status: "booked" };
    return {
      code: "success", touched: [name],
      result: { status: "booked", appointment_id: appt.appointment_id, provider: prov.name, start: appt.start, visit_type: visitType },
      mutations: [
        addRecord(this.collections, "bookings", { patient: name, slot_id: slot, provider: prov.name, visit_type: visitType }),
        { collection: "appointments", op: "add", before: null, after: { ...appt },
          apply: () => { this.appointments.push(appt); need.forEach((s) => this.open.delete(s)); } },
      ],
    };
  }

  private cancel(a: Record<string, unknown>): ToolOutcome {
    const ap = this.appointment(a.appointment_id);
    if (!ap) return err("appointment_not_found", "No appointment with that id.");
    if (ap.status === "cancelled") return err("already_cancelled", "That appointment is already cancelled.");
    const freed = occupiedSlots(this.cal, ap.slot_id, this.visitTypes[ap.visit_type]!.minutes) ?? [ap.slot_id];
    return {
      code: "success", touched: [ap.patient],
      result: { status: "cancelled", appointment_id: ap.appointment_id },
      mutations: [
        addRecord(this.collections, "cancellations", { appointment_id: ap.appointment_id, patient: ap.patient }),
        { collection: "appointments", op: "update", before: { appointment_id: ap.appointment_id, status: "booked" }, after: { appointment_id: ap.appointment_id, status: "cancelled" },
          apply: () => { ap.status = "cancelled"; freed.forEach((s) => this.open.add(s)); } },
      ],
    };
  }

  private waitlist(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name) return err("patient_not_found", "No matching patient.");
    const prov = this.provider(a.provider);
    if (!prov) return err("unknown_provider", "No clinic provider by that name.");
    const visitType = String(a.visit_type);
    if (!this.visitTypes[visitType]) return err("unknown_visit_type", `visit_type must be one of: ${Object.keys(this.visitTypes).join(", ")}.`);
    const w = parseDateRange(a.window);
    if (!w) return err("invalid_window", "window must look like YYYY-MM-DD..YYYY-MM-DD.");
    const record = { patient: name, provider: prov.name, visit_type: visitType, window_start: w.start, window_end: w.end };
    return { code: "success", touched: [name], result: { status: "added", ...record }, mutations: [addRecord(this.collections, "waitlist_entries", record)] };
  }

  private callback(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name) return err("patient_not_found", "No matching patient.");
    const priority = String(a.priority).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!(PRIORITIES as readonly string[]).includes(priority)) return err("invalid_priority", "priority must be routine, same_day or urgent.");
    const record = { patient: name, priority, reason_tag: reasonTag(a.reason) };
    return {
      code: "success", touched: [name], result: { status: "flagged", patient: name, priority },
      mutations: [addRecord(this.collections, "callbacks", record)],
      handoff: { to: "clinic_staff", reason: String(a.reason), via_tool: "flag_callback", context_passed: { patient: name, reason: a.reason, priority } },
    };
  }

  private nurse(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name) return err("patient_not_found", "No matching patient.");
    const record = { patient: name, reason_tag: reasonTag(a.reason) };
    return {
      code: "success", touched: [name], endsCall: true, result: { status: "transferred", patient: name },
      mutations: [addRecord(this.collections, "nurse_line_transfers", record)],
      handoff: { to: "nurse_line", reason: String(a.reason), via_tool: "transfer_to_nurse_line", context_passed: { patient: name, reason: a.reason } },
    };
  }

  // ------------------------------------------------------------------ snapshot
  worldState(): Record<string, unknown> {
    return { appointments: structuredClone(this.appointments), open_slots: [...this.open].sort() };
  }
}
