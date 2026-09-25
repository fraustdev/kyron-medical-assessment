/**
 * The agent interface. An agent sees ONLY the conversation so far and the tool definitions;
 * it never receives the scenario, the fixture, expected states or the caller's brief.
 */
import type { LlmCallInfo } from "../trace/types.js";
import type { ToolDef } from "../world/base.js";

export interface ToolCallRequest { tool: string; args: Record<string, unknown> }
export interface ExecutedToolCall extends ToolCallRequest { call_id: string }

/** The conversation as the agent sees it. Tool results are the only channel for world data. */
export type Message =
  | { role: "caller"; text: string }
  | { role: "agent"; text: string; tool_calls: ExecutedToolCall[] }
  | { role: "tool"; call_id: string; tool: string; result: unknown };

export interface AgentResponse {
  /** What the agent says. May be empty on a response that only calls tools. */
  text: string;
  /** Tool calls to run before the agent speaks again. Empty = the agent's turn is over. */
  tool_calls: ToolCallRequest[];
  /** The raw provider response (for debugging), or null. */
  raw: unknown;
  /** The agent ends the call after this turn. */
  end_call?: boolean;
  llm?: LlmCallInfo;
}

export interface AgentInfo {
  id: string;
  version: string;
  provider: string | null;
  model: string | null;
  /** The fully rendered system prompt, or null (ScriptedAgent). Hashed into run metadata. */
  prompt_text: string | null;
}

export interface Agent {
  info(): AgentInfo;
  respond(conversation: readonly Message[], toolDefs: readonly ToolDef[]): Promise<AgentResponse>;
}
