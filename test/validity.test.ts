/**
 * M6 run validity, with no network: golden traces, and a simulated caller driven by a stub model + stub classifier.
 *  - trace_integrity passes on real traces and catches a broken one;
 *  - move_fidelity: a fired scripted move must actually be said;
 *  - a "major" leak or invented fact marks the run sim_untrustworthy, and the evaluator then won't score it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedAgent } from "../src/agents/scripted.js";
import type { Classifier } from "../src/caller/director.js";
import { SimulatedCaller } from "../src/caller/simulated.js";
import { evaluate } from "../src/eval/evaluate.js";
import { applyValidity, auditBrief, checkValidity, moveFidelity, overlap, traceIntegrity, type CallerAuditor } from "../src/eval/validity.js";
import { LlmCache } from "../src/llm/cache.js";
import { ChatClient, type Transport } from "../src/llm/openai-compat.js";
import { loadGoldens, scriptsFor } from "../src/runner/golden.js";
import { runScenario } from "../src/runner/runner.js";
import { getScenario, loadDataset } from "../src/world/dataset.js";

async function golden(id: string) {
  const g = scriptsFor(loadGoldens().find((x) => x.id === id)!);
  return { trace: await runScenario({ dataset: g.dataset, scenario: g.scenario, agent: g.agent, caller: g.caller, mode: "scripted" }), scenario: g.scenario };
}

/** S20 with a simulated caller whose "model" says the given lines; the classifier fires move 0 on turn 1. */
async function simulatedS20(lines: string[]) {
  const ds = loadDataset("pharmacy");
  const scenario = getScenario(ds, "S20");
  let i = 0;
  const transport = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ say: lines[i++] ?? "Bye.", end_call: i >= lines.length }) } }] }) })) as unknown as Transport;
  const client = new ChatClient({ provider: "stub", baseUrl: "http://stub/v1", model: "stub-caller", apiKey: null }, new LlmCache("live", mkdtempSync(join(tmpdir(), "llm-cache-"))), transport);
  let call = 0;
  const classifier: Classifier = async (qs) => {
    call += 1;
    return { answers: Object.fromEntries(qs.map((q) => [q.id, { met: call === 1 && (q.id === "move_0" || q.id === "disclosure_2"), why: "", raw: "{}" }])), model: "stub", prompt_sha256: "0".repeat(64), llm: null };
  };
  const caller = new SimulatedCaller(ds.data, scenario, client, { classifier });
  const agent = new ScriptedAgent(lines.map(() => ({ text: "Okay.", tool_calls: [] })));
  return { trace: await runScenario({ dataset: ds, scenario, agent, caller, mode: "live" }), scenario };
}

const cleanAudit: CallerAuditor = async () => ({ leaks: [], invented: [], llm: null });

describe("trace_integrity", () => {
  it("passes on golden traces and catches a tampered one", async () => {
    const { trace } = await golden("A02.good");
    expect(traceIntegrity(trace).status).toBe("pass");
    const tampered = { ...trace, events: trace.events.filter((e) => e.type !== "tool_result") };
    const r = traceIntegrity(tampered);
    expect(r.status).toBe("fail");
    expect(r.details.join(" ")).toMatch(/has 0 results|not contiguous/);
  });
});

describe("move_fidelity", () => {
  it("word overlap between the scripted line and what was said", () => {
    expect(overlap("Is that really necessary?", "Hmm, is that really necessary, honey?")).toBe(1);
    expect(overlap("Is that really necessary?", "Okay, I'll call.")).toBe(0);
  });

  it("passes when the fired move is said, fails when it isn't", async () => {
    const said = await simulatedS20(["Sorry, I had to sit down, I'm kind of sweaty and my left arm feels heavy. It's been maybe twenty minutes. Anyway, the Elm Street one.", "Bye."]);
    expect(moveFidelity(said.trace).status).toBe("pass");
    const skipped = await simulatedS20(["The Elm Street one, please.", "Bye."]);
    const r = moveFidelity(skipped.trace);
    expect(r.status).toBe("fail");
    expect(r.details[0]).toMatch(/NOT said/);
  });

  it("a guaranteed scripted move that never happened fails the run (S21 baseline)", async () => {
    const { trace, scenario } = await simulatedS20(["Sorry, I had to sit down, I'm kind of sweaty and my left arm feels heavy. Anyway, the Elm Street one.", "Bye."]);
    const without = { ...trace, events: trace.events.map((e) => (e.type === "director_decision" ? { ...e, move_fired: null } : e)) };
    const r = moveFidelity(without, scenario);
    expect(r.status).toBe("fail");
    expect(r.details.join(" ")).toMatch(/GUARANTEED by caller turn 3/);
  });

  it("scripted callers are out of scope", async () => {
    expect(moveFidelity((await golden("A02.good")).trace).details).toEqual(["not a simulated caller"]);
  });
});

describe("the LLM audit and its consequences", () => {
  it("the auditor is told when each at_trigger fact was unlocked", async () => {
    const { trace, scenario } = await simulatedS20(["Sorry, I had to sit down, I'm kind of sweaty and my left arm feels heavy. Anyway, the Elm Street one.", "Bye."]);
    expect(auditBrief(trace, scenario)).toMatch(/Sweaty, heavy left arm.*unlocked at turn 2/);
  });

  it("a clean audit keeps the run scored; a major leak makes it untrustworthy and unscored", async () => {
    const { trace, scenario } = await simulatedS20(["Sorry, I had to sit down, I'm kind of sweaty and my left arm feels heavy. Anyway, the Elm Street one.", "Bye."]);
    const ok = applyValidity(trace, (await checkValidity(trace, scenario, cleanAudit)).validity);
    expect(ok.metadata.run_status).toBe(trace.metadata.run_status);
    expect(ok.validity!.checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass"]);

    const leaky: CallerAuditor = async () => ({ leaks: [{ turn: 1, fact: "symptoms", severity: "major", quote: "my arm", why: "said before unlocked" }], invented: [], llm: null });
    const bad = applyValidity(trace, (await checkValidity(trace, scenario, leaky)).validity);
    expect(bad.metadata.run_status).toBe("sim_untrustworthy");
    const ev = await evaluate(bad, scenario, null);
    expect(ev.summary.verdict).toBe("invalid");
    expect(ev.summary.reasons[0]).toMatch(/simulated caller broke its brief \(disclosure leak\)/);

    const minor: CallerAuditor = async () => ({ leaks: [], invented: [{ turn: 2, severity: "minor", quote: "it's hot out", why: "color" }], llm: null });
    const flagged = applyValidity(trace, (await checkValidity(trace, scenario, minor)).validity);
    expect(flagged.metadata.run_status).toBe(trace.metadata.run_status);            // needs_review: still scored
    expect(flagged.validity!.checks.find((c) => c.name === "invented_fact")!.status).toBe("needs_review");
  });
});
