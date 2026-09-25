/**
 * Loading the frozen scenario datasets. These types are deliberately loose: the datasets are validated by
 * scripts/validate_scenarios.py + scenario.schema.json, so the harness only types what it reads.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatasetName, FaultBehavior } from "../trace/types.js";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATASET_FILES = {
  pharmacy: "pharmacy_call_scenarios.v2.json",
  scheduling: "scheduling_call_scenarios.v1.json",
} as const;
export type DatasetKey = keyof typeof DATASET_FILES;

export interface AuthorizedContact { name: string; relationship: string; type: string; dob?: string }

export interface Prescription {
  rx_id: string; drug: string; schedule: string | null; status: "active" | "filled" | "unfilled_erx" | "inactive";
  refills: number; store_id: string; prescriber: string | null; earliest_fill?: string; filled_date?: string;
  purpose?: string; notes?: string;
}
export interface PharmacyPatient {
  name: string; dob: string; phone?: string; home_store: string;
  authorized_contacts: AuthorizedContact[]; restricted_contacts: { name: string }[]; prescriptions: Prescription[];
}
export interface PharmacyFixture { store_ids: string[]; patients: PharmacyPatient[]; notes?: string }

export interface Appointment {
  appointment_id: string; patient: string; provider: string; slot_id: string; start: string; visit_type: string; status: "booked";
}
export interface ClinicPatient {
  name: string; dob: string; phone?: string; provider_of_record: string;
  authorized_contacts: AuthorizedContact[]; restricted_contacts: { name: string }[];
}
export interface ClinicFixture {
  provider_ids: string[]; patients: ClinicPatient[]; appointments: Appointment[]; open_slots: string[];
  external_records?: Record<string, unknown>[]; notes?: string;
}

export interface ToolFault {
  tool: string; on_call: number | "all"; behavior: FaultBehavior; value?: unknown; match?: { query_contains?: string };
}

export interface Scenario {
  id: string; status: string; category: string; title: string; urgency_tier: string;
  caller: Record<string, unknown>;
  disclosure_rules: { fact: string; reveal: string; trigger?: string }[];
  scripted_moves: { trigger: string; say: string }[];
  caller_stop_conditions: string[];
  pharmacy_fixture?: PharmacyFixture;
  clinic_fixture?: ClinicFixture;
  tool_faults?: ToolFault[];
  expected_end_state: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Store { id: string; name: string; address: string; phone?: string; notes?: string }
export interface Provider { id: string; name: string; role: string }
export interface CalendarSpec {
  date_range: [string, string]; weekdays_only: boolean; day_start: string; day_end: string; slot_minutes: number;
}

export interface Dataset {
  dataset: DatasetName; version: string; simulated_now: string;
  agent_context: { tools: string[]; [k: string]: unknown };
  policies: { id: string; title: string; text: string; [k: string]: unknown }[];
  state_model: { collections: Record<string, unknown>; [k: string]: unknown };
  caller_sim_instructions: string[];
  stores?: Store[];
  providers?: Provider[];
  visit_types?: Record<string, { minutes: number }>;
  calendar?: CalendarSpec;
  scenarios: Scenario[];
}

export interface LoadedDataset { key: DatasetKey; path: string; sha256: string; data: Dataset }

const cache = new Map<DatasetKey, LoadedDataset>();

export function loadDataset(key: DatasetKey): LoadedDataset {
  const hit = cache.get(key);
  if (hit) return hit;
  const path = join(REPO_ROOT, DATASET_FILES[key]);
  const bytes = readFileSync(path);
  const loaded: LoadedDataset = { key, path, sha256: createHash("sha256").update(bytes).digest("hex"), data: JSON.parse(bytes.toString("utf8")) as Dataset };
  cache.set(key, loaded);
  return loaded;
}

export function getScenario(ds: LoadedDataset, id: string): Scenario {
  const s = ds.data.scenarios.find((x) => x.id === id);
  if (!s) throw new Error(`scenario ${id} not found in ${ds.data.dataset}`);
  return s;
}

/** Tool names declared by a dataset (the text before "(" in agent_context.tools). */
export function declaredToolNames(ds: Dataset): string[] {
  return ds.agent_context.tools.map((t) => t.split("(")[0]!.trim());
}

/** The dataset's state collections (end-state keys other than identity_verified). */
export function stateCollections(ds: Dataset): string[] {
  return Object.keys(ds.state_model.collections).filter((k) => k !== "identity_verified");
}
