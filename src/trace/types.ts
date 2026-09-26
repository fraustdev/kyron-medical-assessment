/**
 * Run trace: the single artifact a harness run produces.
 *
 * A run = metadata + an ordered event list + a final snapshot (+ run-validity checks, added in M6).
 * Part 2 RECORDS; it never grades the agent. Part 3 reads these traces.
 *
 * This file and `trace.schema.json` describe the same shape. The enum arrays below are the single source
 * of truth for every closed vocabulary; `test/trace.schema.test.ts` fails if the schema's enums drift from them.
 */

export const TRACE_VERSION = "1.0.0" as const;

export const DATASET_NAMES = ["harbor-pharmacy-call-scenarios", "harbor-clinic-scheduling-scenarios"] as const;
export type DatasetName = (typeof DATASET_NAMES)[number];

export const CALLER_TYPES = ["scripted", "simulated", "human"] as const;
export type CallerType = (typeof CALLER_TYPES)[number];

export const RUN_MODES = ["live", "replay", "scripted"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_STATUSES = ["completed", "turn_cap_hit", "agent_error", "harness_error", "sim_untrustworthy"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const EVENT_TYPES = [
  "caller_turn", "agent_turn", "tool_call", "tool_result", "state_change", "director_decision", "error", "call_end",
] as const;

export const CALL_END_REASONS = ["stop_condition", "turn_cap", "agent_hangup", "transfer", "emergency_instruction"] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

/** Fault behaviors, identical to the datasets' `tool_fault_types`. */
export const FAULT_BEHAVIORS = ["timeout", "error", "returns_pending", "silent_noop", "latency_ms", "returns_empty"] as const;
export type FaultBehavior = (typeof FAULT_BEHAVIORS)[number];

export const STATE_OPS = ["add", "remove", "update", "set"] as const;
export type StateOp = (typeof STATE_OPS)[number];

export const ERROR_SOURCES = ["agent", "tool", "caller", "llm", "harness"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const HANDOFF_TARGETS = ["nurse_line", "pharmacist", "clinic_staff", "prescriber", "emergency_services"] as const;
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

/** Tools whose successful result must carry a handoff payload (what context was passed to a human). */
export const HANDOFF_TOOLS = ["transfer_to_nurse_line", "flag_callback", "flag_pharmacist_callback"] as const;

export const TRIGGER_EVIDENCE_KINDS = ["tool_event", "llm_check", "turn_count", "rule"] as const;

export const VALIDITY_CHECK_NAMES = ["disclosure_leak", "move_fidelity", "invented_fact", "trace_integrity"] as const;
export type ValidityCheckName = (typeof VALIDITY_CHECK_NAMES)[number];

export const VALIDITY_STATUSES = ["pass", "fail", "needs_review"] as const;
export type ValidityStatus = (typeof VALIDITY_STATUSES)[number];

/** `success`, `timeout`, or `error:<code>`; matches the datasets' check_dsl `result` field. */
export type ResultCode = "success" | "timeout" | `error:${string}`;

// ---------------------------------------------------------------------------------------------- metadata

export interface DatasetRef {
  name: DatasetName;
  version: string;
  /** sha256 of the dataset file bytes the run used. */
  file_sha256: string;
}

export interface AgentRef {
  id: string;            // e.g. "v1", "scripted"
  version: string;
  provider: string | null;   // null for ScriptedAgent
  model: string | null;
  /** sha256 of the fully rendered system prompt; null when there is no prompt (ScriptedAgent). */
  prompt_sha256: string | null;
  /** The rendered prompt itself (M3). Stored so a run is inspectable without the code that produced it. */
  prompt_text: string | null;
}

export interface CallerRef {
  type: CallerType;
  provider: string | null;   // null for scripted / human
  model: string | null;
  /** Version of the director (disclosure/move logic); null when there is no director (scripted). */
  director_version: string | null;
}

export interface RunMetadata {
  run_id: string;
  scenario_id: string;
  dataset: DatasetRef;
  agent: AgentRef;
  caller: CallerRef;
  seed: number;
  trial_index: number;
  mode: RunMode;
  started_at: string;        // ISO-8601
  ended_at: string;          // ISO-8601
  run_status: RunStatus;
  harness_version: string;
  /** Max caller turns for this run (from the scenario/dataset). */
  turn_cap: number;
  /** The dataset's simulated clock, copied for convenience. */
  simulated_now: string;
}

// ---------------------------------------------------------------------------------------------- events

interface EventBase {
  /** 0-based, contiguous, unique within the run. Also the event's id (other events refer to it by seq). */
  seq: number;
  /** Milliseconds since run start; non-decreasing. */
  t_ms: number;
  /** Conversation turn the event belongs to (a turn = one caller utterance + the agent's full response). */
  turn: number;
}

export interface CallerTurnEvent extends EventBase {
  type: "caller_turn";
  text: string;
  source: CallerType;
  /** The simulated caller's LLM call(s) that produced this line. */
  llm_calls?: LlmCallInfo[];
}

export interface LlmCallInfo {
  /** Key into the LLM call cache: hash(provider, model, messages, params). */
  cache_key: string;
  cache_hit: boolean;
  latency_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AgentTurnEvent extends EventBase {
  type: "agent_turn";
  /** What the agent said to the caller at the end of this turn (may be empty if it only called tools). */
  text: string;
  /** call_ids of the tool calls the agent made during this turn, in order. */
  tool_call_ids: string[];
  /** The last LLM call of the turn (the one that produced the spoken text). */
  llm?: LlmCallInfo;
  /** Every LLM call of the turn, in order (tool rounds included), for cost. */
  llm_calls?: LlmCallInfo[];
  /** Raw provider response, when available (for debugging). */
  raw?: unknown;
}

/**
 * Fields the harness extracts from tool args so graders can match on them
 * (the datasets' trace_contract). Absent keys = not applicable to this tool.
 */
export interface NormalizedFields {
  patient?: string | null;
  rx_id?: string | null;
  store_id?: string | null;
  from_store?: string | null;
  to_store?: string | null;
  prescriber?: string | null;
  slot_id?: string | null;
  appointment_id?: string | null;
  provider?: string | null;
  visit_type?: string | null;
}

export interface ToolCallEvent extends EventBase {
  type: "tool_call";
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  normalized: NormalizedFields;
}

export interface AppliedFault {
  /** Index into the scenario's tool_faults array. */
  fault_index: number;
  behavior: FaultBehavior;
  value?: unknown;
  /** For timeouts: whether the write actually happened despite the timeout. */
  committed?: boolean;
}

export interface Handoff {
  to: HandoffTarget;
  reason: string;
  /** Exactly what context the agent passed to the human (patient, summary, priority, ...). */
  context_passed: Record<string, unknown>;
  /** Tool that performed the handoff, or null if it was verbal only (e.g. "hang up and call 911"). */
  via_tool: string | null;
}

export interface ToolResultEvent extends EventBase {
  type: "tool_result";
  call_id: string;
  tool: string;
  /** What the agent received (after faults). For a silent_noop this looks like success. */
  result: unknown;
  result_code: ResultCode;
  fault_applied: AppliedFault | null;
  latency_ms: number;
  /** Required for successful HANDOFF_TOOLS results. */
  handoff?: Handoff;
}

export interface StateChangeEvent extends EventBase {
  type: "state_change";
  collection: string;           // a state_model collection, or "identity_verified"
  op: StateOp;
  before: unknown;              // null for add
  after: unknown;               // null for remove
  /** The tool call that caused it. */
  call_id: string;
}

export type TriggerEvidence =
  | { kind: "tool_event"; seq: number; description: string }
  | { kind: "llm_check"; question: string; model: string; prompt_sha256: string; raw_output: string; verdict: boolean }
  | { kind: "turn_count"; value: number; description: string }
  | { kind: "rule"; description: string };

export interface DisclosureRef {
  /** Index into the scenario's disclosure_rules. */
  index: number;
  fact: string;
}

export interface MoveRef {
  /** Index into the scenario's scripted_moves. */
  index: number;
  say: string;
}

export interface DirectorDecisionEvent extends EventBase {
  type: "director_decision";
  /** Facts newly allowed for the caller to reveal this turn. */
  unlocked_disclosures: DisclosureRef[];
  /** The scripted move that fires this turn, if any. */
  move_fired: MoveRef | null;
  /** Why: tool events, the classifier's raw output, turn counts, or deterministic rules. */
  trigger_evidence: TriggerEvidence[];
  /** The director's classifier call(s) this turn. */
  llm_calls?: LlmCallInfo[];
}

export interface ErrorEvent extends EventBase {
  type: "error";
  source: ErrorSource;
  message: string;
  fatal: boolean;
  detail?: unknown;
}

export interface CallEndEvent extends EventBase {
  type: "call_end";
  reason: CallEndReason;
  detail: string;
  /** Required when reason = "transfer". */
  handoff?: Handoff;
}

export type TraceEvent =
  | CallerTurnEvent | AgentTurnEvent | ToolCallEvent | ToolResultEvent
  | StateChangeEvent | DirectorDecisionEvent | ErrorEvent | CallEndEvent;

// ---------------------------------------------------------------------------------------------- final snapshot

export interface ToolCallSummary {
  seq: number;          // seq of the tool_call event
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  result_code: ResultCode;
}

export interface FinalSnapshot {
  /** The dataset's state_model collections, in the same shape as a scenario's expected_end_state. */
  end_state: { identity_verified: boolean } & Record<string, unknown>;
  /** The full mutable world after the call (prescriptions/appointments as the tools left them). */
  world_state: Record<string, unknown>;
  tool_calls: ToolCallSummary[];
  counts: { turns: number; caller_turns: number; agent_turns: number; tool_calls: number; errors: number };
}

// ---------------------------------------------------------------------------------------------- validity (M6)

export interface ValidityCheck {
  name: ValidityCheckName;
  status: ValidityStatus;
  details: string[];
}

export interface RunValidity {
  computed_at: string;
  checks: ValidityCheck[];
}

// ---------------------------------------------------------------------------------------------- run

export interface Trace {
  trace_version: typeof TRACE_VERSION;
  metadata: RunMetadata;
  events: TraceEvent[];
  final: FinalSnapshot;
  /** Run-validity checks (M6). Absent until computed. */
  validity?: RunValidity;
}
