/**
 * M4: the simulated caller's director, with a stub classifier and a stub caller model (no network).
 *  - every trigger in both datasets parses to the expected mechanism (tool event, rule, turn count, classifier);
 *  - one scripted line per turn, lowest-numbered first, with the deferral logged (A02's overlapping triggers);
 *  - at_trigger facts stay locked, and out of the caller's prompt, until their trigger fires (S06, via the trace);
 *  - "fire anyway by caller turn N" fallbacks; "the agent's next turn after <previous move>";
 *  - the caller model never sees tool calls/results, unfired moves or grading data;
 *  - a 911 instruction makes the caller's hang-up an emergency_instruction ending.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "../src/agents/types.js";
import { Director, EMERGENCY_QUESTION, parseTrigger, type Classifier, type ClassifierQuestion } from "../src/caller/director.js";
import { renderCallerSystemPrompt, SimulatedCaller, visibleSamples } from "../src/caller/simulated.js";
import { LlmCache } from "../src/llm/cache.js";
import { ChatClient, type Transport } from "../src/llm/openai-compat.js";
import type { TraceEvent } from "../src/trace/types.js";
import { getScenario, loadDataset, type DatasetKey } from "../src/world/dataset.js";

/** A classifier that says "met" for exactly the ids listed for that call (one list per call). */
function stubClassifier(plan: string[][]): Classifier & { asked: ClassifierQuestion[][] } {
  const asked: ClassifierQuestion[][] = [];
  const f = (async (questions: ClassifierQuestion[]) => {
    asked.push(questions);
    const yes = new Set(plan[asked.length - 1] ?? []);
    return {
      answers: Object.fromEntries(questions.map((q) => [q.id, { met: yes.has(q.id), why: "stub", raw: `{"met":${yes.has(q.id)}}` }])),
      model: "stub-classifier", prompt_sha256: "0".repeat(64), llm: null,
    };
  }) as unknown as Classifier & { asked: ClassifierQuestion[][] };
  f.asked = asked;
  return f;
}

const said = (...turns: [string, string][]): Message[] =>
  turns.flatMap(([c, a]) => [{ role: "caller" as const, text: c }, { role: "agent" as const, text: a, tool_calls: [] }]);

const agentTurn = (turn: number, seq: number): TraceEvent => ({ type: "agent_turn", seq, t_ms: 0, turn, text: "", tool_call_ids: [] });

describe("trigger parsing", () => {
  it("maps each trigger to the cheapest reliable mechanism", () => {
    expect(parseTrigger("right after the agent confirms her identity").rule).toEqual({ kind: "identity_verified" });
    expect(parseTrigger("after identity is verified, before any transfer is confirmed").rule).toEqual({ kind: "identity_verified" });
    expect(parseTrigger("the agent's first turn after identity is verified (before a transfer is confirmed)").rule).toEqual({ kind: "identity_verified" });
    expect(parseTrigger("the agent's first response after the opening line (before any refill is confirmed); fire anyway by caller turn 3"))
      .toEqual({ rule: { kind: "agent_turn_count", n: 1 }, fireByCallerTurn: 3 });
    expect(parseTrigger("the agent's second turn; fire anyway by caller turn 3")).toEqual({ rule: { kind: "agent_turn_count", n: 2 }, fireByCallerTurn: 3 });
    expect(parseTrigger("the agent's next turn after he says Zoloft", 1).rule).toEqual({ kind: "after_move", move: 0 });
    expect(parseTrigger("the agent starts or confirms transferring the albuterol; fire anyway before the final read-back").rule)
      .toEqual({ kind: "llm", question: "the agent starts or confirms transferring the albuterol; or, failing that, before the final read-back" });
    expect(parseTrigger("the agent offers one or more Thursday afternoon times")).toEqual({ rule: { kind: "llm", question: "the agent offers one or more Thursday afternoon times" }, fireByCallerTurn: null });
  });

  it.each<DatasetKey>(["pharmacy", "scheduling"])("%s: every move and at_trigger fact has a mechanism", (key) => {
    for (const s of loadDataset(key).data.scenarios) {
      s.scripted_moves.forEach((m, i) => {
        const p = parseTrigger(m.trigger, i);
        if (p.rule.kind === "llm") expect(p.rule.question.length).toBeGreaterThan(10);
      });
      for (const d of s.disclosure_rules) if (d.reveal === "at_trigger") expect(d.trigger, `${s.id}: ${d.fact}`).toBeTruthy();
    }
  });
});

describe("director", () => {
  const sched = loadDataset("scheduling");
  const pharm = loadDataset("pharmacy");

  it("turn 0: the opening line verbatim; only upfront facts available, only_if_asked and at_trigger locked", async () => {
    const s = getScenario(pharm, "S06");
    const d = await new Director(s, stubClassifier([])).decide(0, [], []);
    expect(d.directive).toEqual({ kind: "opening", text: s.caller.opening_line });
    const atTrigger = s.disclosure_rules.map((r, i) => [r, i] as const).filter(([r]) => r.reveal === "at_trigger").map(([, i]) => i);
    expect(atTrigger.length).toBeGreaterThan(0);
    for (const i of atTrigger) expect(d.allowed.map((a) => a.index)).not.toContain(i);
    expect(d.allowed.every((a) => a.reveal === "upfront")).toBe(true);
  });

  it("only_if_asked facts unlock when the classifier says the agent asked for them", async () => {
    const s = getScenario(pharm, "S10");
    const week = s.disclosure_rules.findIndex((r) => r.fact.includes("week"));
    const cls = stubClassifier([[], [`asked_${week}`]]);
    const dir = new Director(s, cls);
    await dir.decide(0, [], []);
    expect((await dir.decide(1, [], [agentTurn(0, 1)])).allowed.map((a) => a.index)).not.toContain(week);
    expect(cls.asked[0]!.some((q) => q.id === `asked_${week}` && q.condition.includes("about a week"))).toBe(true);
    const d2 = await dir.decide(2, [], [agentTurn(0, 1), agentTurn(1, 3)]);
    expect(d2.unlocked_disclosures.map((u) => u.index)).toContain(week);
  });

  it("persona clauses that give away a guarded fact are left out until allowed (S15, A08 baseline leaks)", async () => {
    const { redact } = await import("../src/caller/simulated.js");
    expect(redact("58, authorized caregiver; didn't know the amlodipine was out of refills; only 3 pills left.", ["Only 3 pills left"]))
      .toBe("58, authorized caregiver; didn't know the amlodipine was out of refills;");
    const a08 = getScenario(loadDataset("scheduling"), "A08");
    const guarded = a08.disclosure_rules.filter((r) => r.reveal !== "upfront").map((r) => r.fact);
    expect(redact(String(a08.caller.persona), guarded)).not.toMatch(/week/);
  });

  it("one scripted line per turn, lowest first: A02 moves 1 and 2 met together -> 1 now, 2 next turn (deferral logged)", async () => {
    const s = getScenario(sched, "A02");
    const cls = stubClassifier([[], ["move_1", "move_2"], []]);
    const dir = new Director(s, cls);
    await dir.decide(0, [], []);
    const conv1 = said([String(s.caller.opening_line), "What's your date of birth?"]);
    expect((await dir.decide(1, conv1, [agentTurn(0, 1)])).directive.kind).toBe("free");

    const d2 = await dir.decide(2, conv1, [agentTurn(0, 1), agentTurn(1, 3)]);
    expect(d2.move_fired?.index).toBe(1);
    expect(d2.trigger_evidence.some((e) => e.kind === "rule" && e.description.includes("move 2 waits"))).toBe(true);

    const d3 = await dir.decide(3, conv1, [agentTurn(0, 1), agentTurn(1, 3), agentTurn(2, 5)]);
    expect(d3.move_fired?.index).toBe(2);                   // fires although the classifier said nothing this turn
    expect(cls.asked[2]!.map((q) => q.id)).not.toContain("move_2"); // already armed: not asked again
  });

  it("identity triggers come from the trace (tool_event evidence), not the classifier", async () => {
    const s = getScenario(pharm, "S06");
    const dir = new Director(s, stubClassifier([[], []]));
    await dir.decide(0, [], []);
    const locked = s.disclosure_rules.findIndex((r) => r.reveal === "at_trigger");
    expect((await dir.decide(1, [], [agentTurn(0, 1)])).allowed.map((a) => a.index)).not.toContain(locked);

    const verified: TraceEvent = { type: "state_change", seq: 7, t_ms: 0, turn: 1, collection: "identity_verified", op: "set", before: false, after: true, call_id: "c1" };
    const d = await dir.decide(2, [], [agentTurn(0, 1), verified, agentTurn(1, 8)]);
    expect(d.move_fired?.index).toBe(0);
    expect(d.unlocked_disclosures.map((u) => u.index)).toContain(locked);
    expect(d.trigger_evidence).toContainEqual(expect.objectContaining({ kind: "tool_event", seq: 7 }));
  });

  it("fallbacks: 'fire anyway by caller turn 3' and 'the agent's next turn after <previous move>'", async () => {
    const s10 = getScenario(pharm, "S10");
    const dir = new Director(s10, stubClassifier([[], [], []]));
    await dir.decide(0, [], []);
    // S10 move 0 = the agent's first response: fires on caller turn 2 by rule
    expect((await dir.decide(1, [], [agentTurn(0, 1)])).move_fired?.index).toBe(0);

    const s11 = getScenario(pharm, "S11");
    const d11 = new Director(s11, stubClassifier([["move_0"], [], []]));
    await d11.decide(0, [], []);
    expect((await d11.decide(1, [], [agentTurn(0, 1)])).move_fired?.index).toBe(0);
    const next = await d11.decide(2, [], [agentTurn(0, 1), agentTurn(1, 3)]);
    expect(next.move_fired?.index).toBe(1);
    expect(next.trigger_evidence).toContainEqual(expect.objectContaining({ kind: "rule" }));
  });

  it("a due scripted move comes before a met stop condition (S01: 'what, honey?' before hanging up)", async () => {
    const s01 = getScenario(pharm, "S01");
    const dir = new Director(s01, stubClassifier([["move_0", "stop_0"], ["stop_0"]]));
    await dir.decide(0, [], []);
    const d1 = await dir.decide(1, [], [agentTurn(0, 1)]);
    expect(d1.move_fired?.index).toBe(0);
    expect(d1.trigger_evidence.some((e) => e.kind === "rule" && e.description.includes("move comes first"))).toBe(true);
    expect((await dir.decide(2, [], [agentTurn(0, 1), agentTurn(1, 3)])).directive.kind).toBe("stop");
  });

  it("stop conditions wait until every guaranteed scripted move has happened (S21 baseline)", async () => {
    const s21 = getScenario(pharm, "S21");
    const cls = stubClassifier([["stop_1"], [], ["stop_1"]]);
    const dir = new Director(s21, cls);
    await dir.decide(0, [], []);
    const d1 = await dir.decide(1, [], [agentTurn(0, 1)]);                      // agent's 1st turn: move 0 not due yet
    expect(d1.directive.kind).toBe("free");
    expect(cls.asked[0]!.some((q) => q.id.startsWith("stop_"))).toBe(false);
    const d2 = await dir.decide(2, [], [agentTurn(0, 1), agentTurn(1, 3)]);   // agent's 2nd turn: move 0 fires
    expect(d2.move_fired?.index).toBe(0);
    const d3 = await dir.decide(3, [], [agentTurn(0, 1), agentTurn(1, 3), agentTurn(2, 5)]);
    expect(d3.directive.kind).toBe("stop");                                    // now stops can end the call
  });

  it("a met stop condition ends the call; turn-cap conditions are left to the runner", async () => {
    const s = getScenario(sched, "A02");
    const cls = stubClassifier([["stop_0"]]);
    const dir = new Director(s, cls);
    await dir.decide(0, [], []);
    const d = await dir.decide(1, [], [agentTurn(0, 1)]);
    expect(d.directive).toEqual({ kind: "stop", condition: s.caller_stop_conditions[0] });
    expect(cls.asked[0]!.map((q) => q.condition)).not.toContain("Caller has made 12 turns.");
    expect(cls.asked[0]!.map((q) => q.condition)).toContain(EMERGENCY_QUESTION);
  });
});

// ------------------------------------------------------------------------------------------ the LLM layer

function stubModel(replies: string[]): Transport & { requests: any[] } {
  const requests: any[] = [];
  const t = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body));
    const content = replies[requests.length - 1];
    if (content === undefined) return { ok: false, status: 500, text: async () => "stub exhausted" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  }) as unknown as Transport & { requests: any[] };
  t.requests = requests;
  return t;
}
const client = (t: Transport) => new ChatClient({ provider: "stub", baseUrl: "http://stub/v1", model: "stub-caller", apiKey: null },
  new LlmCache("live", mkdtempSync(join(tmpdir(), "llm-cache-"))), t);

describe("simulated caller (LLM layer)", () => {
  const pharm = loadDataset("pharmacy");

  it("the caller model never sees tool calls, tool results, unfired moves, locked facts or grading", async () => {
    const s = getScenario(pharm, "S06");
    const model = stubModel([`{"say":"Yes, that's me.","end_call":false}`]);
    const caller = new SimulatedCaller(pharm.data, s, client(model), { classifier: stubClassifier([[]]) });
    await caller.next({ turn: 0, conversation: [], events: [] });
    const conversation: Message[] = [
      { role: "caller", text: String(s.caller.opening_line) },
      { role: "agent", text: "", tool_calls: [{ call_id: "c1", tool: "verify_identity", args: { patient: "X" } }] },
      { role: "tool", call_id: "c1", tool: "verify_identity", result: { verified: true, secret_marker: "TOOL-RESULT-XYZ" } },
      { role: "agent", text: "Can you confirm your date of birth?", tool_calls: [] },
    ];
    const u = await caller.next({ turn: 1, conversation, events: [agentTurn(0, 1)] });
    expect(u?.text).toBe("Yes, that's me.");
    const seen = JSON.stringify(model.requests[0].messages);
    expect(seen).not.toContain("TOOL-RESULT-XYZ");
    expect(seen).not.toContain("verify_identity");
    for (const m of s.scripted_moves) expect(seen).not.toContain(m.say);
    for (const d of s.disclosure_rules) if (d.reveal === "at_trigger") expect(seen).not.toContain(d.fact);
    expect(seen).not.toContain("expected_end_state");
    expect(seen).not.toContain("grading");
    expect(u?.director?.move_fired).toBeNull();
  });

  it("every scenario's caller system prompt excludes at_trigger facts and grading data", () => {
    for (const key of ["pharmacy", "scheduling"] as DatasetKey[]) {
      const ds = loadDataset(key).data;
      for (const s of ds.scenarios) {
        const p = renderCallerSystemPrompt(ds, s);
        for (const d of s.disclosure_rules) if (d.reveal === "at_trigger") expect(p, s.id).not.toContain(d.fact);
        expect(p).not.toContain(JSON.stringify(s.expected_end_state));
      }
    }
  });

  it("sample lines that give away a scripted line or a guarded fact stay hidden until due (S13, S10 baseline leaks)", async () => {
    const s13 = getScenario(pharm, "S13");
    const d13 = await new Director(s13, stubClassifier([])).decide(0, [], []);
    const shown13 = visibleSamples(s13, d13);
    expect(shown13).not.toContain("And the anxiety one while you're at it.");   // scripted move 1, not fired yet
    expect(shown13).not.toContain("So is it moved or not?");                   // scripted move 2
    expect(shown13).toContain("March 3rd, 1942. I'm her son, I'm on the account."); // ordinary voice sample stays
    const s10 = getScenario(pharm, "S10");
    const shown10 = visibleSamples(s10, await new Director(s10, stubClassifier([])).decide(0, [], []));
    expect(shown10).not.toContain("I have about a week left.");                  // only_if_asked fact
    expect(shown10).toContain("How long will that take?");
  });

  it("after the agent says to call 911, the caller's hang-up is recorded as emergency_instruction", async () => {
    const s = getScenario(pharm, "S20");
    const model = stubModel([`{"say":"Okay, okay. I'll hang up and call.","end_call":true}`]);
    const caller = new SimulatedCaller(pharm.data, s, client(model), { classifier: stubClassifier([["emergency"]]) });
    await caller.next({ turn: 0, conversation: [], events: [] });
    const u = await caller.next({ turn: 1, conversation: said([String(s.caller.opening_line), "Please hang up and call 911 right now."]), events: [agentTurn(0, 1)] });
    expect(u).toMatchObject({ hang_up_after: true, end_reason: "emergency_instruction" });
  });
});
