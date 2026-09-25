/**
 * Harbor Pharmacy mock tools. Semantics follow the dataset's agent_context.tools and state_model exactly
 * (see pharmacy_call_scenarios.v2.json -> state_model.collections[*].written_by and tool_lookup_scope).
 */
import type { NormalizedFields } from "../trace/types.js";
import { addRecord, BaseWorld, err, type Handler, type Mutation, type ToolDef, type ToolOutcome } from "./base.js";
import type { LoadedDataset, PharmacyPatient, Prescription, Scenario, Store } from "./dataset.js";
import type { Recorder } from "./recorder.js";
import { addDays, normName, parseDate, reasonTag, simulatedDate } from "./util.js";

const PRIORITIES = ["routine", "same_day", "urgent"] as const;
const CHAIN_WORDS: Record<string, "H" | "B"> = { harbor: "H", brightway: "B" };
const STOPWORDS = new Set(["pharmacy", "drug", "the", "on", "in", "at", "near", "by", "st", "street", "store", "and", "of", "a", "one", "location"]);

interface RxEntry { rx: Prescription; owner: string }

export class PharmacyWorld extends BaseWorld {
  private readonly patients: PharmacyPatient[];
  private readonly stores: Store[];
  private readonly defaultStores = new Map<string, string>();
  protected readonly handlers: Record<string, Handler>;

  constructor(dataset: LoadedDataset, scenario: Scenario, recorder: Recorder) {
    super(dataset, scenario, recorder);
    if (!scenario.pharmacy_fixture) throw new Error(`${scenario.id} has no pharmacy_fixture`);
    const fx = structuredClone(scenario.pharmacy_fixture);
    this.patients = fx.patients;
    this.stores = dataset.data.stores ?? [];
    for (const p of this.patients) this.defaultStores.set(p.name, p.home_store);
    this.handlers = this.buildHandlers();
  }

  // ------------------------------------------------------------------ lookups
  private names(): string[] { return this.patients.map((p) => p.name); }
  private allRx(): RxEntry[] { return this.patients.flatMap((p) => p.prescriptions.map((rx) => ({ rx, owner: p.name }))); }
  private rxById(id: unknown): RxEntry | null {
    if (typeof id !== "string") return null;
    const k = id.trim().toLowerCase();
    return this.allRx().find((e) => e.rx.rx_id.toLowerCase() === k) ?? null;
  }
  private store(id: unknown): Store | null {
    if (typeof id !== "string") return null;
    const k = id.trim().toUpperCase();
    return this.stores.find((s) => s.id.toUpperCase() === k) ?? null;
  }
  private isHarbor(storeId: string): boolean { return storeId.startsWith("H-"); }
  private canonicalPrescriber(given: unknown, rx: Prescription | null): string {
    const g = String(given ?? "").trim();
    if (rx?.prescriber) {
      const last = normName(rx.prescriber).split(" ").pop()!;
      if (normName(g).split(" ").includes(last)) return rx.prescriber;
    }
    return g;
  }
  /** Inbound transfers may name the Rx by description (state_model.tool_lookup_scope.transfer_rx). */
  private resolveInbound(rx: unknown, fromStore: string): RxEntry | "ambiguous" | null {
    const byId = this.rxById(rx);
    if (byId && byId.rx.store_id === fromStore) return byId;
    if (typeof rx !== "string") return null;
    const words = normName(rx).split(" ").filter((w) => w.length > 2);
    const hits = this.allRx().filter((e) => e.rx.store_id === fromStore && words.some((w) => normName(e.rx.drug).split(" ").includes(w)));
    if (hits.length > 1) return "ambiguous";
    return hits[0] ?? null;
  }
  private readyTime(): string { return `${addDays(simulatedDate(this.dataset.data.simulated_now), 1)}T10:00`; }

  private refillsMutation(rx: Prescription, next: number): Mutation {
    return { collection: "prescriptions", op: "update", before: { rx_id: rx.rx_id, refills: rx.refills }, after: { rx_id: rx.rx_id, refills: next },
      apply: () => { rx.refills = next; } };
  }

  // ------------------------------------------------------------------ tools
  private buildHandlers(): Record<string, Handler> {
    const desc = (name: string) => this.dataset.data.agent_context.tools.find((t) => t.startsWith(`${name}(`)) ?? name;
    const def = (name: string, params: ToolDef["params"]): ToolDef => ({ name, description: desc(name), params });
    const P = (name: string, description: string, required = true) => ({ name, type: "string" as const, required, description });
    const patientNorm = (a: Record<string, unknown>): NormalizedFields => ({ patient: this.resolvePatient(a.patient, this.names()) ?? (a.patient as string ?? null) });

    return {
      verify_identity: {
        def: def("verify_identity", [P("patient", "Patient full name"), P("dob", "Patient date of birth"), P("second_factor", "Address or phone, if needed", false)]),
        write: false, normalize: patientNorm,
        run: (a) => this.verifyIdentity(a),
      },
      list_prescriptions: {
        def: def("list_prescriptions", [P("patient", "Verified patient's full name")]),
        write: false, normalize: patientNorm,
        run: (a) => this.listPrescriptions(a),
      },
      find_stores: {
        def: def("find_stores", [P("query", "Words from the store's name, street, city or cross street")]),
        write: false, normalize: () => ({}),
        run: (a) => this.findStores(a),
      },
      queue_refill: {
        def: def("queue_refill", [P("rx", "rx_id from list_prescriptions"), P("store", "Store id for pickup, e.g. H-110")]),
        write: true,
        normalize: (a) => { const e = this.rxById(a.rx); return { patient: e?.owner ?? null, rx_id: e?.rx.rx_id ?? (a.rx as string), store_id: this.store(a.store)?.id ?? (a.store as string) }; },
        run: (a) => this.queueRefill(a),
      },
      request_renewal: {
        def: def("request_renewal", [P("rx", "rx_id from list_prescriptions"), P("prescriber", "Prescriber's name"), P("store", "Store id")]),
        write: true,
        normalize: (a) => { const e = this.rxById(a.rx); return { patient: e?.owner ?? null, rx_id: e?.rx.rx_id ?? (a.rx as string), prescriber: this.canonicalPrescriber(a.prescriber, e?.rx ?? null), store_id: this.store(a.store)?.id ?? (a.store as string) }; },
        run: (a) => this.requestRenewal(a),
      },
      request_new_rx: {
        def: def("request_new_rx", [P("based_on_rx", "rx_id of the prescription the new one replaces"), P("prescriber", "Prescriber's name"), P("store", "Store id where the new Rx should be sent")]),
        write: true,
        normalize: (a) => { const e = this.rxById(a.based_on_rx); return { patient: e?.owner ?? null, rx_id: e?.rx.rx_id ?? (a.based_on_rx as string), prescriber: this.canonicalPrescriber(a.prescriber, e?.rx ?? null), store_id: this.store(a.store)?.id ?? (a.store as string) }; },
        run: (a) => this.requestNewRx(a),
      },
      transfer_rx: {
        def: def("transfer_rx", [P("rx", "rx_id (for an inbound transfer from another chain, a drug description is accepted)"), P("from_store", "Store id the Rx is at now"), P("to_store", "Store id it should move to")]),
        write: true,
        normalize: (a) => {
          const from = this.store(a.from_store)?.id ?? (a.from_store as string);
          const r = typeof from === "string" ? this.resolveInbound(a.rx, from) : null;
          const e = r && r !== "ambiguous" ? r : this.rxById(a.rx);
          return { patient: e?.owner ?? null, rx_id: e?.rx.rx_id ?? (a.rx as string), from_store: from, to_store: this.store(a.to_store)?.id ?? (a.to_store as string) };
        },
        run: (a) => this.transferRx(a),
      },
      set_default_store: {
        def: def("set_default_store", [P("patient", "Patient's full name"), P("store", "Store id")]),
        write: true,
        normalize: (a) => ({ ...patientNorm(a), store_id: this.store(a.store)?.id ?? (a.store as string) }),
        run: (a) => this.setDefaultStore(a),
      },
      add_caregiver_authorization_request: {
        def: def("add_caregiver_authorization_request", [P("patient", "Patient's full name"), P("caregiver", "Caregiver's full name")]),
        write: true, normalize: patientNorm,
        run: (a) => this.addCaregiverAuth(a),
      },
      flag_pharmacist_callback: {
        def: def("flag_pharmacist_callback", [P("patient", "Patient's full name"), P("reason", "Why the pharmacist should call, with the relevant context"), P("priority", "routine | same_day | urgent")]),
        write: true, normalize: patientNorm,
        run: (a) => this.flagPharmacist(a),
      },
    };
  }

  private verifyIdentity(a: Record<string, unknown>): ToolOutcome {
    const dob = parseDate(a.dob);
    const name = this.resolvePatient(a.patient, this.names());
    const p = name ? this.patients.find((x) => x.name === name) : undefined;
    // Same answer for "no such patient" and "wrong DOB": a failed check must not reveal whether someone is a patient.
    if (!p || !dob || dob !== p.dob) return err("not_verified", "The name and date of birth do not match our records.");
    return {
      code: "success", mutations: [], verified: p.name, touched: [p.name],
      result: {
        verified: true, patient: p.name, home_store: p.home_store, default_store: this.defaultStores.get(p.name),
        authorized_contacts: p.authorized_contacts.map((c) => ({ name: c.name, relationship: c.relationship })),
        restricted_contacts: p.restricted_contacts.map((c) => ({ name: c.name })),
      },
    };
  }

  private listPrescriptions(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name || !this.isVerified(name)) return err("not_verified", "Verify the patient's identity first.");
    const p = this.patients.find((x) => x.name === name)!;
    const queued = this.collections.refills_queued as { rx_id: string; store_id: string }[];
    const rxs = p.prescriptions.filter((rx) => this.isHarbor(rx.store_id)).map((rx) => ({
      rx_id: rx.rx_id, drug: rx.drug, schedule: rx.schedule, status: rx.status, refills: rx.refills, store_id: rx.store_id,
      prescriber: rx.prescriber, ...(rx.earliest_fill ? { earliest_fill: rx.earliest_fill } : {}),
      queued_refills: queued.filter((q) => q.rx_id === rx.rx_id).map((q) => ({ store_id: q.store_id, ready_time: this.readyTime() })),
    }));
    return { code: "success", mutations: [], touched: [name], result: { patient: name, prescriptions: rxs } };
  }

  private findStores(a: Record<string, unknown>): ToolOutcome {
    const words = String(a.query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const chain = words.map((w) => CHAIN_WORDS[w]).find(Boolean);
    const terms = words.filter((w) => !CHAIN_WORDS[w] && !STOPWORDS.has(w));
    const hits = this.stores.filter((s) => {
      if (chain && !s.id.startsWith(`${chain}-`)) return false;
      const hay = `${s.id} ${s.name} ${s.address} ${s.notes ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    return { code: "success", mutations: [], result: { stores: hits.map((s) => ({ store_id: s.id, name: s.name, address: s.address, ...(s.phone ? { phone: s.phone } : {}), ...(s.notes ? { notes: s.notes } : {}) })) } };
  }

  private queueRefill(a: Record<string, unknown>): ToolOutcome {
    const e = this.rxById(a.rx);
    if (!e) return err("rx_not_found", "No prescription with that rx_id. Use an rx_id from list_prescriptions.");
    const { rx, owner } = e;
    if (!this.isHarbor(rx.store_id)) return err("not_held_here", "That prescription is not held at a Harbor Pharmacy store.");
    if (rx.schedule === "C-II" || rx.status === "filled") return err("not_refillable", "This prescription cannot be refilled; a new prescription is required.");
    if (rx.status === "unfilled_erx") return err("not_refillable", "This prescription has not been filled yet and cannot be refilled.");
    if (rx.refills <= 0) return err("no_refills", "This prescription has no refills remaining.");
    const st = this.store(a.store);
    if (!st) return err("unknown_store", "Unknown store id.");
    const record = { rx_id: rx.rx_id, store_id: st.id };
    return {
      code: "success", touched: [owner],
      result: { status: "queued", rx_id: rx.rx_id, store_id: st.id, ready_time: this.readyTime() },
      mutations: [addRecord(this.collections, "refills_queued", record), this.refillsMutation(rx, rx.refills - 1)],
    };
  }

  private requestRenewal(a: Record<string, unknown>): ToolOutcome {
    const e = this.rxById(a.rx);
    if (!e) return err("rx_not_found", "No prescription with that rx_id. Use an rx_id from list_prescriptions.");
    if (e.rx.schedule === "C-II") return err("use_new_rx", "A C-II prescription needs a new prescription (request_new_rx), not a renewal.");
    const st = this.store(a.store);
    if (!st) return err("unknown_store", "Unknown store id.");
    const record = { rx_id: e.rx.rx_id, prescriber: this.canonicalPrescriber(a.prescriber, e.rx), store_id: st.id };
    return { code: "success", touched: [e.owner], result: { status: "sent", ...record }, mutations: [addRecord(this.collections, "renewal_requests", record)] };
  }

  private requestNewRx(a: Record<string, unknown>): ToolOutcome {
    const e = this.rxById(a.based_on_rx);
    if (!e) return err("rx_not_found", "No prescription with that rx_id. Use an rx_id from list_prescriptions.");
    const st = this.store(a.store);
    if (!st) return err("unknown_store", "Unknown store id.");
    const record = { rx_id: e.rx.rx_id, prescriber: this.canonicalPrescriber(a.prescriber, e.rx), store_id: st.id };
    return { code: "success", touched: [e.owner], result: { status: "sent", ...record }, mutations: [addRecord(this.collections, "new_rx_requests", record)] };
  }

  private transferRx(a: Record<string, unknown>): ToolOutcome {
    const from = this.store(a.from_store), to = this.store(a.to_store);
    if (!from || !to) return err("unknown_store", "Unknown from_store or to_store id.");
    const fromH = this.isHarbor(from.id), toH = this.isHarbor(to.id);
    if (fromH && !toH) return err("receiving_pharmacy_must_request", "Harbor cannot send a transfer out. The receiving pharmacy must call Harbor to request it.");
    if (!fromH && !toH) return err("not_supported", "Transfers between two other pharmacies are not supported.");

    let e: RxEntry | null;
    if (fromH) {
      e = this.rxById(a.rx);
      if (!e) return err("rx_not_found", "No prescription with that rx_id. Use an rx_id from list_prescriptions.");
      if (e.rx.store_id !== from.id) return err("rx_not_at_store", "That prescription is not held at from_store.");
    } else {
      const r = this.resolveInbound(a.rx, from.id);
      if (r === "ambiguous") return err("ambiguous_rx", "More than one prescription at that pharmacy matches; be more specific.");
      if (!r) return err("rx_not_found", "The other pharmacy has no matching prescription.");
      e = r;
    }
    const { rx, owner } = e;
    const existing = (this.collections.transfers as { rx_id: string; status: string }[]).find((t) => t.rx_id === rx.rx_id && t.status !== "completed");
    if (existing) return err("already_requested", "A transfer for this prescription is already in progress.");

    let status: "completed" | "requested" | "pending_pharmacist";
    if (rx.schedule === "C-II") {
      if (rx.status !== "unfilled_erx") return err("not_transferable", "A filled C-II prescription cannot be transferred; a new prescription is required.");
      status = "pending_pharmacist";
    } else if (rx.schedule) {
      status = "pending_pharmacist";          // C-III..V: transferable once, pharmacist handles it
    } else {
      if (rx.refills <= 0) return err("no_refills", "A prescription with no refills cannot be transferred.");
      status = fromH ? "completed" : "requested";
    }
    const record = { rx_id: rx.rx_id, from_store: from.id, to_store: to.id, status };
    const mutations: Mutation[] = [addRecord(this.collections, "transfers", record)];
    if (status === "completed") {
      mutations.push({ collection: "prescriptions", op: "update", before: { rx_id: rx.rx_id, store_id: rx.store_id }, after: { rx_id: rx.rx_id, store_id: to.id },
        apply: () => { rx.store_id = to.id; } });
    }
    return { code: "success", touched: [owner], mutations, result: { status, rx_id: rx.rx_id, from_store: from.id, to_store: to.id } };
  }

  private setDefaultStore(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name) return err("patient_not_found", "No matching patient.");
    const st = this.store(a.store);
    if (!st) return err("unknown_store", "Unknown store id.");
    const record = { patient: name, store_id: st.id };
    const before = this.defaultStores.get(name) ?? null;
    return {
      code: "success", touched: [name], result: { status: "updated", ...record },
      mutations: [addRecord(this.collections, "default_store_changes", record),
        { collection: "default_stores", op: "update", before: { patient: name, store_id: before }, after: record, apply: () => { this.defaultStores.set(name, st.id); } }],
    };
  }

  private addCaregiverAuth(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name) return err("patient_not_found", "No matching patient.");
    const record = { patient: name, caregiver: String(a.caregiver).trim() };
    return { code: "success", touched: [name], result: { status: "request_created", ...record }, mutations: [addRecord(this.collections, "caregiver_auth_requests", record)] };
  }

  private flagPharmacist(a: Record<string, unknown>): ToolOutcome {
    const name = this.resolvePatient(a.patient, this.names());
    if (!name) return err("patient_not_found", "No matching patient.");
    const priority = String(a.priority).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!(PRIORITIES as readonly string[]).includes(priority)) return err("invalid_priority", "priority must be routine, same_day or urgent.");
    const record = { patient: name, priority, reason_tag: reasonTag(a.reason) };
    return {
      code: "success", touched: [name], result: { status: "flagged", patient: name, priority },
      mutations: [addRecord(this.collections, "pharmacist_callbacks", record)],
      handoff: { to: "pharmacist", reason: String(a.reason), via_tool: "flag_pharmacist_callback", context_passed: { patient: name, reason: a.reason, priority } },
    };
  }

  // ------------------------------------------------------------------ snapshot
  worldState(): Record<string, unknown> {
    return {
      prescriptions: Object.fromEntries(this.allRx().map(({ rx, owner }) => [rx.rx_id, { owner, refills: rx.refills, store_id: rx.store_id, status: rx.status }])),
      default_stores: Object.fromEntries(this.defaultStores),
    };
  }
}
