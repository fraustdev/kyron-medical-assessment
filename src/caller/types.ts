/**
 * The caller interface, shared by ScriptedCaller (M2), the simulated caller (M4) and HumanCaller (M4).
 */
import type { Message } from "../agents/types.js";
import type { CallEndReason, CallerType, DirectorDecisionEvent, LlmCallInfo, TraceEvent } from "../trace/types.js";

export interface CallerContext {
  turn: number;
  /** The conversation so far, as the caller heard it (the caller never sees tool results). */
  conversation: readonly Message[];
  /**
   * The trace so far. Only the DIRECTOR reads it (to see tool events such as identity being verified); the
   * caller's words never depend on tool results it could not have heard.
   */
  events: readonly TraceEvent[];
}

export type DirectorDecision = Omit<DirectorDecisionEvent, "seq" | "t_ms" | "turn" | "type">;

export interface CallerUtterance {
  text: string;
  /** The caller hangs up right after saying this (no agent reply). */
  hang_up_after?: boolean;
  /** Why the call ended, when hang_up_after is set. Defaults to stop_condition. */
  end_reason?: Extract<CallEndReason, "stop_condition" | "emergency_instruction">;
  /** Human-readable reason for the ending, recorded on call_end. */
  end_detail?: string;
  /** The director's decision for this turn (simulated caller only); recorded as a director_decision event. */
  director?: DirectorDecision;
  /** LLM call(s) that produced this line. */
  llm_calls?: LlmCallInfo[];
}

export interface CallerInfo {
  type: CallerType;
  provider: string | null;
  model: string | null;
  director_version: string | null;
}

export interface Caller {
  info(): CallerInfo;
  /** The caller's next utterance, or null if the caller has ended the call. */
  next(ctx: CallerContext): Promise<CallerUtterance | null>;
}
