/**
 * Minimal client for any OpenAI-compatible /chat/completions endpoint. No SDK dependency.
 * Default: Anthropic's OpenAI-compatible endpoint. Local Ollama works too (BASE_URL=http://localhost:11434/v1).
 *
 * Config (per role, so the agent and the simulated caller can use different models):
 *   <ROLE>_BASE_URL   default https://api.anthropic.com/v1
 *   <ROLE>_MODEL      default: AGENT claude-haiku-4-5-20251001, CALLER and JUDGE claude-sonnet-5
 *   <ROLE>_API_KEY    needed for live calls only (replay reads the cache); never written to traces or the cache
 *   <ROLE>_PROVIDER   label recorded in run metadata, default "anthropic"
 *
 * The defaults matter for replay: the cache key includes provider + model, so a reviewer with no .env replays
 * exactly the committed runs.
 */
import { LlmCache, requestKey, CacheMissError, type CacheMode } from "./cache.js";
import type { LlmCallInfo } from "../trace/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatParams {
  temperature?: number; seed?: number; max_tokens: number;
  /** For reasoning models. "none" disables thinking (qwen3 via Ollama); omitted = provider default. */
  reasoning_effort?: "none" | "low" | "medium" | "high";
}

export interface ChatResult {
  message: { content: string | null; tool_calls?: { id?: string; function: { name: string; arguments: string | Record<string, unknown> } }[] };
  raw: unknown;
  llm: LlmCallInfo;
}

export interface LlmConfig { provider: string; baseUrl: string; model: string; apiKey: string | null }

/**
 * Request params a model rejects, dropped before the request (and before the cache key, so live and replay agree).
 * Newer Claude models fix sampling themselves and return 400 "temperature is deprecated for this model".
 */
const UNSUPPORTED_PARAMS: { model: RegExp; params: (keyof ChatParams)[] }[] = [
  { model: /^claude-(sonnet|opus)-5/, params: ["temperature"] },
];

export function supportedParams(model: string, params: ChatParams): ChatParams {
  const drop = new Set(UNSUPPORTED_PARAMS.filter((r) => r.model.test(model)).flatMap((r) => r.params));
  return Object.fromEntries(Object.entries(params).filter(([k, v]) => v !== undefined && !drop.has(k as keyof ChatParams))) as unknown as ChatParams;
}

export const DEFAULT_MODELS = { AGENT: "claude-haiku-4-5-20251001", CALLER: "claude-sonnet-5", JUDGE: "claude-sonnet-5" } as const;

export function llmConfigFromEnv(role: keyof typeof DEFAULT_MODELS, env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return {
    provider: env[`${role}_PROVIDER`] || "anthropic",
    baseUrl: (env[`${role}_BASE_URL`] || "https://api.anthropic.com/v1").replace(/\/$/, ""),
    model: env[`${role}_MODEL`] || DEFAULT_MODELS[role],
    // The judge uses the same provider account as the caller unless given its own key.
    apiKey: env[`${role}_API_KEY`] || (role === "JUDGE" ? env.CALLER_API_KEY : undefined) || null,
  };
}

/** Transport is injectable so tests never touch the network. */
export type Transport = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ChatClient {
  constructor(
    readonly config: LlmConfig,
    private readonly cache: LlmCache,
    private readonly transport: Transport = (url, init) => fetch(url, init),
    private readonly maxRetries = 5,
    private readonly retryBaseMs = 2000,
  ) {}

  get cacheMode(): CacheMode { return this.cache.mode; }

  async complete(messages: ChatMessage[], tools: ChatTool[], requested: ChatParams): Promise<ChatResult> {
    const params = supportedParams(this.config.model, requested);
    // The key covers everything that determines the answer, but never the API key.
    const request = { provider: this.config.provider, model: this.config.model, messages, tools, params };
    const key = requestKey(request);

    const hit = this.cache.get(key);
    if (hit) {
      return { ...parse(hit.response), llm: { cache_key: key, cache_hit: true, latency_ms: hit.latency_ms, ...usage(hit.response) } };
    }
    if (this.cache.mode === "replay") throw new CacheMissError(key);

    const body = JSON.stringify({ model: this.config.model, messages, ...(tools.length ? { tools } : {}), ...params, stream: false });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    // Retry what a busy provider throws at a long batch (rate limits, overload, dropped connections); fail fast on
    // anything that won't fix itself (bad request, bad key, no credit). Latency is the successful attempt's only.
    let text = "", latency = 0;
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let status = 0;
      try {
        const res = await this.transport(`${this.config.baseUrl}/chat/completions`, { method: "POST", headers, body });
        text = await res.text();
        status = res.status;
        latency = Date.now() - t0;
        if (res.ok) break;
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
      }
      const retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
      if (!retryable || attempt >= this.maxRetries) throw new Error(`LLM HTTP ${status || "network error"}: ${text.slice(0, 300)}`);
      await sleep(Math.min(30_000, this.retryBaseMs * 2 ** attempt));
    }
    const response = JSON.parse(text) as unknown;
    this.cache.put({ key, request, response, latency_ms: latency, created_at: new Date().toISOString() });
    return { ...parse(response), llm: { cache_key: key, cache_hit: false, latency_ms: latency, ...usage(response) } };
  }
}

function parse(response: unknown): Omit<ChatResult, "llm"> {
  const r = response as { choices?: { message?: ChatResult["message"] }[] };
  const message = r.choices?.[0]?.message;
  if (!message) throw new Error(`LLM response has no choices[0].message: ${JSON.stringify(response).slice(0, 300)}`);
  return { message, raw: response };
}

function usage(response: unknown): Pick<LlmCallInfo, "usage"> {
  const u = (response as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  if (!u) return {};
  return { usage: { ...(u.prompt_tokens !== undefined ? { input_tokens: u.prompt_tokens } : {}), ...(u.completion_tokens !== undefined ? { output_tokens: u.completion_tokens } : {}) } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
