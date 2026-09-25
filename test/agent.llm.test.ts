/**
 * M3: the LLM agent, without touching the network (a stub transport stands in for the model).
 *  - the rendered prompt contains no fixture data, expected states, grading info or caller briefs, for EVERY scenario;
 *  - conversation -> chat messages mapping, tool schemas, argument parsing;
 *  - the cache: live writes, a repeat is a hit, replay reads, a replay miss fails loudly, the API key is never stored;
 *  - a full run through the runner with a stubbed model, then the same run replayed from the cache alone.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmAgent, parseArgs, toChatMessages } from "../src/agents/llm.js";
import { renderAgentPromptV1, sanitizePolicyText, spokenNow } from "../src/agents/prompt.js";
import { ScriptedCaller } from "../src/caller/scripted.js";
import { CacheMissError, LlmCache } from "../src/llm/cache.js";
import { ChatClient, type Transport } from "../src/llm/openai-compat.js";
import { runScenario } from "../src/runner/runner.js";
import { getScenario, loadDataset, type DatasetKey } from "../src/world/dataset.js";

const KEYS: DatasetKey[] = ["pharmacy", "scheduling"];

describe("agent v1 prompt", () => {
  it.each(KEYS)("%s: contains no fixture data, expected states, grading info or caller briefs (every scenario)", (key) => {
    const ds = loadDataset(key).data;
    const prompt = renderAgentPromptV1(ds);
    const forbidden = new Set<string>();
    for (const s of ds.scenarios) {
      const fx: any = s.pharmacy_fixture ?? s.clinic_fixture;
      for (const p of fx.patients) {
        forbidden.add(p.name); forbidden.add(p.dob);
        if (p.phone) forbidden.add(p.phone);
        for (const c of p.authorized_contacts) forbidden.add(c.name);
        for (const rx of p.prescriptions ?? []) forbidden.add(rx.rx_id);
      }
      for (const a of fx.appointments ?? []) { forbidden.add(a.appointment_id); forbidden.add(a.slot_id); }
      for (const slot of fx.open_slots ?? []) forbidden.add(slot);
      const caller: any = s.caller;
      forbidden.add(caller.opening_line); forbidden.add(caller.persona); forbidden.add(caller.goal);
      for (const line of caller.sample_lines) forbidden.add(line);
      for (const d of s.disclosure_rules) forbidden.add(d.fact);
      for (const m of s.scripted_moves) forbidden.add(m.say);
      const g: any = s.grading;
      forbidden.add(g.success_summary);
      for (const c of [...g.state_checks, ...g.judged_checks]) forbidden.add(c.text);
      for (const c of g.claim_checks) forbidden.add(c.claim);
    }
    for (const f of forbidden) if (f.length > 3) expect(prompt.includes(f), `prompt contains: ${f.slice(0, 60)}`).toBe(false);
    // no evaluation vocabulary either
    expect(prompt).not.toMatch(/\b[SA]\d{2}\b|OQS?-\d{2}|expected_end_state|must_do|must_not_do|grading|scenario/i);
  });

  it("names the right customer, states the current date and includes every policy", () => {
    const ds = loadDataset("scheduling").data;
    const p = renderAgentPromptV1(ds);
    expect(p).toContain("phone agent for Harbor Family Medicine");
    expect(p).toContain("Thursday, September 24, 2026, 4:40 PM");
    for (const pol of ds.policies) expect(p).toContain(pol.id);
  });

  it("strips evaluation notes from policy text without changing the rule", () => {
    expect(sanitizePolicyText("Reassurance about an expected effect (S06, S24) is permitted.")).toBe("Reassurance about an expected effect is permitted.");
    expect(sanitizePolicyText("No proof is required. (Unauthorized callers are left undefined until a scenario needs them: author decision OQS-09.)"))
      .toBe("No proof is required.");
    expect(spokenNow("2026-09-24T16:40:00 (Thursday, local time)")).toBe("Thursday, September 24, 2026, 4:40 PM (local time)");
  });
});

describe("chat mapping", () => {
  it("maps caller/agent/tool messages to OpenAI chat roles with matching tool_call ids", () => {
    const m = toChatMessages([
      { role: "caller", text: "Hi" },
      { role: "agent", text: "", tool_calls: [{ call_id: "c1", tool: "verify_identity", args: { patient: "X", dob: "Y" } }] },
      { role: "tool", call_id: "c1", tool: "verify_identity", result: { verified: true } },
      { role: "agent", text: "You're verified.", tool_calls: [] },
    ]);
    expect(m).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "verify_identity", arguments: "{\"patient\":\"X\",\"dob\":\"Y\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"verified\":true}" },
      { role: "assistant", content: "You're verified." },
    ]);
  });
  it("records unparseable tool arguments instead of throwing", () => {
    expect(parseArgs("{\"a\":1}")).toEqual({ a: 1 });
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 });
    expect(parseArgs("not json")).toEqual({ __unparsed_arguments: "not json" });
  });
});

// ------------------------------------------------------------------------ stub model
/** A fake OpenAI-compatible endpoint that plays scripted assistant messages, one per request. */
function stubTransport(replies: object[]): Transport & { requests: any[] } {
  const requests: any[] = [];
  const t = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    const message = replies[requests.length - 1];
    if (!message) return { ok: false, status: 500, text: async () => "stub exhausted" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  }) as unknown as Transport & { requests: any[] };
  t.requests = requests;
  return t;
}
const call = (name: string, args: object) => ({ function: { name, arguments: JSON.stringify(args) } });
const tmpCache = () => mkdtempSync(join(tmpdir(), "llm-cache-"));
const CONFIG = { provider: "stub", baseUrl: "http://stub/v1", model: "stub-model", apiKey: "sk-SECRET-should-never-be-stored" };

describe("LLM cache", () => {
  it("live writes; the same request is then a hit; replay reads it; a replay miss fails; the API key is never stored", async () => {
    const dir = tmpCache();
    const stub = stubTransport([{ content: "hello" }]);
    const live = new ChatClient(CONFIG, new LlmCache("live", dir), stub);
    const a = await live.complete([{ role: "user", content: "hi" }], [], { temperature: 0, seed: 1, max_tokens: 10 });
    const b = await live.complete([{ role: "user", content: "hi" }], [], { temperature: 0, seed: 1, max_tokens: 10 });
    expect(a.llm.cache_hit).toBe(false);
    expect(b.llm.cache_hit).toBe(true);
    expect(stub.requests).toHaveLength(1);                                  // second call never reached the model
    expect(b.message.content).toBe("hello");

    const replay = new ChatClient(CONFIG, new LlmCache("replay", dir), stubTransport([]));
    expect((await replay.complete([{ role: "user", content: "hi" }], [], { temperature: 0, seed: 1, max_tokens: 10 })).message.content).toBe("hello");
    await expect(replay.complete([{ role: "user", content: "different" }], [], { temperature: 0, seed: 1, max_tokens: 10 })).rejects.toBeInstanceOf(CacheMissError);

    const stored = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".json")).map((f) => readFileSync(join(dir, String(f)), "utf8")).join("");
    expect(stored).not.toContain("SECRET");
  });
});

describe("LlmAgent through the runner (stubbed model)", () => {
  const replies = [
    { content: "Let me look that up.", tool_calls: [call("verify_identity", { patient: "Gloria Hart", dob: "1947-05-12" })] },
    { content: null, tool_calls: [call("list_prescriptions", { patient: "Gloria Hart" })] },
    { content: null, tool_calls: [call("queue_refill", { rx: "RX-GH-AMLO5", store: "H-110" })] },
    { content: "Your amlodipine is queued at Main Street and will be ready tomorrow after 10 AM." },
  ];
  const run = async (mode: "live" | "replay", dir: string, transport: Transport) => {
    const ds = loadDataset("pharmacy");
    const client = new ChatClient(CONFIG, new LlmCache(mode, dir), transport);
    return runScenario({ dataset: ds, scenario: getScenario(ds, "S01"), agent: new LlmAgent(ds.data, client, { seed: 7 }),
      caller: new ScriptedCaller(["Hi, this is Gloria Hart, May 12th 1947. I need my amlodipine refilled.", "Thank you, dear."], true), mode });
  };

  it("runs tools from the model, feeds results back, and records prompt hash + model metadata", async () => {
    const stub = stubTransport(replies);
    const t = await run("live", tmpCache(), stub);
    expect(t.metadata.run_status).toBe("completed");
    expect(t.metadata.agent).toMatchObject({ id: "v1", provider: "stub", model: "stub-model" });
    expect(t.metadata.agent.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(t.metadata.agent.prompt_text).toContain("Harbor Pharmacy");
    expect(t.final.end_state.refills_queued).toEqual([{ rx_id: "RX-GH-AMLO5", store_id: "H-110" }]);
    // the model's 3rd request must contain the list_prescriptions result it asked for
    const third = stub.requests[2];
    expect(third.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c2" });
    expect(third.messages[0].role).toBe("system");
    expect(third.tools.map((x: any) => x.function.name)).toContain("queue_refill");
    const turn = t.events.find((e) => e.type === "agent_turn") as any;
    expect(turn.text).toBe("Let me look that up. Your amlodipine is queued at Main Street and will be ready tomorrow after 10 AM.");
    expect(turn.llm.cache_hit).toBe(false);
  });

  it("replays the identical run from the cache alone (no model), with cache hits recorded", async () => {
    const dir = tmpCache();
    const live = await run("live", dir, stubTransport(replies));
    const replayed = await run("replay", dir, stubTransport([]));        // a transport that would fail if called
    expect(replayed.metadata.run_status).toBe("completed");
    expect(replayed.final).toEqual(live.final);
    const strip = (t: typeof live) => t.events.map((e: any) => (e.type === "agent_turn" ? { ...e, llm: { ...e.llm, cache_hit: null, latency_ms: null },
      llm_calls: e.llm_calls.map((c: any) => ({ ...c, cache_hit: null, latency_ms: null })) } : e));
    expect(strip(replayed)).toEqual(strip(live));
    expect((replayed.events.find((e) => e.type === "agent_turn") as any).llm.cache_hit).toBe(true);
  });

  it("a replay miss ends the run as agent_error, not a crash", async () => {
    const t = await run("replay", tmpCache(), stubTransport([]));
    expect(t.metadata.run_status).toBe("agent_error");
    expect((t.events.find((e) => e.type === "error") as any).message).toContain("CacheMissError");
  });
});
