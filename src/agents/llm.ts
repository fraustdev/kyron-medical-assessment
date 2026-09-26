/**
 * LlmAgent: the real agent. An LLM behind any OpenAI-compatible endpoint (Ollama by default), with the dataset's
 * tools exposed as function calls. It sees only: the system prompt (dataset-level), the conversation, tool results.
 */
import type { ChatClient, ChatMessage, ChatParams, ChatTool } from "../llm/openai-compat.js";
import type { ToolDef } from "../world/base.js";
import type { Dataset } from "../world/dataset.js";
import { PROMPT_VERSION, renderAgentPromptV1 } from "./prompt.js";
import type { Agent, AgentInfo, AgentResponse, Message, ToolCallRequest } from "./types.js";

export interface LlmAgentOptions {
  id?: string;
  /** Sampling temperature. Non-zero so repeated trials can differ; each response is cached by its full request. */
  temperature?: number;
  /** Per-run seed (the runner varies it by trial), included in the request and so in the cache key. */
  seed?: number;
  /** Reply budget. 400 cut off turns with several tool calls (exp batches: S06, S09, S13), so the default is 1024. */
  maxTokens?: number;
  /** Reasoning models only. "none" turns thinking off (a phone agent can't pause 30s to think every turn). */
  reasoningEffort?: ChatParams["reasoning_effort"];
  /** Override the system prompt (used by prompt-variant experiments). */
  promptText?: string;
  promptVersion?: string;
}

export class LlmAgent implements Agent {
  private readonly prompt: string;
  private readonly params: ChatParams;

  constructor(dataset: Dataset, private readonly client: ChatClient, private readonly opts: LlmAgentOptions = {}) {
    this.prompt = opts.promptText ?? renderAgentPromptV1(dataset);
    this.params = {
      temperature: opts.temperature ?? 0.3, seed: opts.seed ?? 0, max_tokens: opts.maxTokens ?? 1024,
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    };
  }

  info(): AgentInfo {
    return { id: this.opts.id ?? PROMPT_VERSION, version: this.opts.promptVersion ?? PROMPT_VERSION,
      provider: this.client.config.provider, model: this.client.config.model, prompt_text: this.prompt };
  }

  async respond(conversation: readonly Message[], toolDefs: readonly ToolDef[]): Promise<AgentResponse> {
    const messages: ChatMessage[] = [{ role: "system", content: this.prompt }, ...toChatMessages(conversation)];
    const r = await this.client.complete(messages, toolDefs.map(toChatTool), this.params);
    const tool_calls: ToolCallRequest[] = (r.message.tool_calls ?? []).map((tc) => ({ tool: tc.function.name, args: parseArgs(tc.function.arguments) }));
    return { text: (r.message.content ?? "").trim(), tool_calls, raw: r.raw, llm: r.llm };
  }
}

export function toChatMessages(conversation: readonly Message[]): ChatMessage[] {
  return conversation.map((m): ChatMessage => {
    if (m.role === "caller") return { role: "user", content: m.text };
    if (m.role === "tool") return { role: "tool", tool_call_id: m.call_id, content: JSON.stringify(m.result) };
    if (m.tool_calls.length === 0) return { role: "assistant", content: m.text };
    return {
      role: "assistant", content: m.text || null,
      tool_calls: m.tool_calls.map((tc) => ({ id: tc.call_id, type: "function" as const, function: { name: tc.tool, arguments: JSON.stringify(tc.args) } })),
    };
  });
}

export function toChatTool(def: ToolDef): ChatTool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(def.params.map((p) => [p.name, { type: p.type, description: p.description }])),
        required: def.params.filter((p) => p.required).map((p) => p.name),
      },
    },
  };
}

/** Tool arguments arrive as a JSON string (OpenAI) or an object (some Ollama versions). Unparseable -> recorded, not thrown. */
export function parseArgs(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw !== "string") return raw ?? {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { __unparsed_arguments: raw };
  } catch {
    return { __unparsed_arguments: raw };
  }
}
