/**
 * Asking a model for a JSON object. Reasoning models can spend their whole token budget thinking and return
 * nothing (seen in the baseline run: finish_reason "length", empty content). One retry with double the budget fixes
 * that; the retry is a different request, so it is cached separately and replays deterministically.
 */
import type { LlmCallInfo } from "../trace/types.js";
import type { ChatClient, ChatMessage, ChatParams } from "./openai-compat.js";

/** The first {...} block in a model reply (models sometimes wrap JSON in prose or code fences). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

export async function completeJson(client: ChatClient, messages: ChatMessage[], params: ChatParams, what: string):
  Promise<{ json: Record<string, unknown>; llm: LlmCallInfo[] }> {
  const llm: LlmCallInfo[] = [];
  let p = params, last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await client.complete(messages, [], p);
    llm.push(r.llm);
    last = r.message.content ?? "";
    const json = parseJsonObject(last);
    if (json) return { json, llm };
    p = { ...p, max_tokens: p.max_tokens * 2 };
  }
  throw new Error(`${what} returned no JSON after a retry: ${last.slice(0, 200) || "(empty reply)"}`);
}
