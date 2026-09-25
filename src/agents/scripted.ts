/**
 * ScriptedAgent: plays a fixed list of turns. Each turn = some tool calls, then something to say.
 * Within a turn, the first respond() returns the tool calls and the next returns the text, exactly like a
 * real LLM agent that calls tools and then answers once it has the results.
 */
import type { Agent, AgentInfo, AgentResponse, ToolCallRequest } from "./types.js";

export interface ScriptedAgentTurn { text: string; tool_calls: ToolCallRequest[]; end_call?: boolean }

export class ScriptExhaustedError extends Error {
  constructor(what: string) { super(`${what} script exhausted`); this.name = "ScriptExhaustedError"; }
}

export class ScriptedAgent implements Agent {
  private i = 0;
  private toolsSent = false;
  constructor(private readonly turns: ScriptedAgentTurn[], private readonly id = "scripted") {}

  info(): AgentInfo {
    return { id: this.id, version: "1", provider: null, model: null, prompt_text: null };
  }

  async respond(): Promise<AgentResponse> {
    const t = this.turns[this.i];
    if (!t) throw new ScriptExhaustedError("agent");
    if (!this.toolsSent && t.tool_calls.length > 0) {
      this.toolsSent = true;
      return { text: "", tool_calls: structuredClone(t.tool_calls), raw: null };
    }
    this.i += 1;
    this.toolsSent = false;
    return { text: t.text, tool_calls: [], raw: null, ...(t.end_call ? { end_call: true } : {}) };
  }

  /** Turns the script still holds (used by tests to confirm a script was fully played). */
  remaining(): number { return this.turns.length - this.i; }
}
