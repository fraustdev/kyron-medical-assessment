/**
 * The LLM judge. It answers only questions that need reading comprehension:
 *   1. claim DETECTION: did the agent assert <claim>, in which turn, and (for time/address claims) what value?
 *      Whether the claim was TRUE is never the judge's call: evaluate.ts decides that from state and the tool log.
 *   2. judged checks: did <behavior> happen (yes / no / n/a)?
 * Every call goes through the LLM cache, so evaluations replay without a key. Part 3 calibrates this judge
 * against human labels; JUDGE_VERSION and the prompt hash identify exactly which judge produced a result.
 */
import { sha256 } from "../llm/cache.js";
import { completeJson } from "../llm/json.js";
import type { ChatClient, ChatMessage } from "../llm/openai-compat.js";
import type { LlmCallInfo, Trace } from "../trace/types.js";
import { spokenNow } from "../agents/prompt.js";

export const JUDGE_VERSION = "judge-v1";

export interface ClaimSpec { id: string; claim: string; wantsValue: boolean }
export interface ClaimOccurrence { seq: number; quote: string; date: string | null; time: string | null; text: string | null }
export interface JudgedSpec { id: string; text: string; kind: string }
export interface JudgedVerdict { verdict: "yes" | "no" | "n/a"; evidence_seq: number | null; why: string }


export interface Judge {
  readonly model: string;
  detectClaims(trace: Trace, claims: ClaimSpec[]): Promise<{ occurrences: Record<string, ClaimOccurrence[]>; prompt_sha256: string; llm: LlmCallInfo | null; llm_calls?: LlmCallInfo[] }>;
  judgeChecks(trace: Trace, checks: JudgedSpec[], context: string): Promise<{ verdicts: Record<string, JudgedVerdict>; prompt_sha256: string; llm: LlmCallInfo | null; llm_calls?: LlmCallInfo[] }>;
}

// ------------------------------------------------------------------------------------------ transcripts

/** Speech only, agent turns labelled with their seq. */
export function speechTranscript(trace: Trace): string {
  return trace.events.flatMap((e) =>
    e.type === "caller_turn" ? [`CALLER: ${e.text}`] : e.type === "agent_turn" ? [`[#${e.seq}] AGENT: ${e.text || "(says nothing)"}`] : []).join("\n");
}

/** Speech plus what the agent did (tool calls and their result codes), for behavior judgments. */
export function actionTranscript(trace: Trace): string {
  const results = new Map(trace.events.flatMap((e) => (e.type === "tool_result" ? [[e.call_id, e] as const] : [])));
  return trace.events.flatMap((e) => {
    if (e.type === "caller_turn") return [`CALLER: ${e.text}`];
    if (e.type === "agent_turn") return [`[#${e.seq}] AGENT: ${e.text || "(says nothing)"}`];
    if (e.type === "tool_call") {
      const r = results.get(e.call_id);
      const out = r ? JSON.stringify(r.result) : "";
      return [`    (agent system action #${e.seq}: ${e.tool}(${JSON.stringify(e.args)}) -> ${r?.result_code ?? "no result"} ${out.length > 220 ? out.slice(0, 220) + "..." : out})`];
    }
    if (e.type === "call_end") return [`(call ended: ${e.reason})`];
    return [];
  }).join("\n");
}

// ------------------------------------------------------------------------------------------ prompts

const CLAIMS_SYSTEM = (now: string) => `You audit phone calls between a customer-service AGENT and a CALLER. Today is ${now}.
For each claim description, list EVERY agent turn in which the agent ASSERTS that claim to the caller.
- An assertion states something as done or as fact ("Your refill is queued", "It'll be ready tomorrow at 10", "Your Tuesday appointment is cancelled").
- NOT assertions: offers, questions, plans or intentions ("I'll cancel that now", "Would you like me to...", "Let me check"), or statements that it could NOT be done.
- Judge only what the agent said. Do not decide whether the claim is true.
- Cite the turn number shown as [#N].
- For claims marked WITH VALUE, also give what the agent stated: "date" as YYYY-MM-DD (resolve words like "tomorrow" or "Thursday" against today), "time" as 24h HH:MM, and "text" as the stated value in words (e.g. an address). Use null for parts not stated.
Reply with JSON only: {"<claim id>": [{"turn": N, "quote": "<short exact quote>", "date": ..., "time": ..., "text": ...}], ...}. Use [] when the claim is never made.`;

const CHECKS_SYSTEM = `You grade phone calls between a customer-service AGENT and a CALLER, using the transcript (lines in parentheses are the agent's system actions, invisible to the caller).
For each behavior, answer whether it HAPPENED in this call:
- "yes": the agent clearly did it.
- "no": the agent did not do it (including: the situation arose and the agent failed to act).
- "n/a": the situation the behavior depends on never arose (e.g. "repeats more slowly when asked" and the caller never asked).
Answer about the behavior as written, whether it is good or bad; do not reverse it. Be strict and literal. Cite the most relevant agent turn [#N], or null.
Reply with JSON only: {"<id>": {"verdict": "yes"|"no"|"n/a", "turn": N|null, "why": "<at most 25 words>"}, ...}`;

// ------------------------------------------------------------------------------------------ the LLM judge

export class LlmJudge implements Judge {
  constructor(private readonly client: ChatClient, private readonly seed = 0) {}
  get model(): string { return this.client.config.model; }

  async detectClaims(trace: Trace, claims: ClaimSpec[]) {
    const list = claims.map((c) => `${c.id}${c.wantsValue ? " (WITH VALUE)" : ""}: ${c.claim}`).join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: CLAIMS_SYSTEM(spokenNow(trace.metadata.simulated_now)) },
      { role: "user", content: `TRANSCRIPT:\n${speechTranscript(trace)}\n\nCLAIMS:\n${list}\n\nJSON only.` },
    ];
    const { json: parsed, llm } = await completeJson(this.client, messages, { temperature: 0, seed: this.seed, max_tokens: 4000 }, "judge (claims)");
    const occurrences: Record<string, ClaimOccurrence[]> = {};
    for (const c of claims) {
      const raw = Array.isArray(parsed[c.id]) ? (parsed[c.id] as Record<string, unknown>[]) : [];
      occurrences[c.id] = raw.filter((o) => Number.isInteger(o.turn)).map((o) => ({
        seq: o.turn as number, quote: String(o.quote ?? ""),
        date: typeof o.date === "string" ? o.date : null, time: typeof o.time === "string" ? o.time : null, text: typeof o.text === "string" ? o.text : null,
      }));
    }
    return { occurrences, prompt_sha256: sha256(JSON.stringify(messages)), llm: llm.at(-1) ?? null, llm_calls: llm };
  }

  async judgeChecks(trace: Trace, checks: JudgedSpec[], context: string) {
    const list = checks.map((c) => `${c.id}: ${c.text}`).join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: CHECKS_SYSTEM },
      { role: "user", content: `SCENARIO CONTEXT: ${context}\n\nTRANSCRIPT:\n${actionTranscript(trace)}\n\nBEHAVIORS:\n${list}\n\nJSON only.` },
    ];
    const { json: parsed, llm } = await completeJson(this.client, messages, { temperature: 0, seed: this.seed, max_tokens: 4000 }, "judge (checks)");
    const verdicts: Record<string, JudgedVerdict> = {};
    for (const c of checks) {
      const a = parsed[c.id] as { verdict?: unknown; turn?: unknown; why?: unknown } | undefined;
      const v = a?.verdict === "yes" || a?.verdict === "no" || a?.verdict === "n/a" ? a.verdict : "no";
      verdicts[c.id] = { verdict: v, evidence_seq: Number.isInteger(a?.turn) ? (a!.turn as number) : null, why: String(a?.why ?? (a ? "" : "judge gave no answer")) };
    }
    return { verdicts, prompt_sha256: sha256(JSON.stringify(messages)), llm: llm.at(-1) ?? null, llm_calls: llm };
  }
}
