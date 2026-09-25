/**
 * Evaluator v1, with no network: the approved golden traces + a stub judge that "detects" claims at chosen turns.
 *  - every check in both datasets evaluates without error (no unsupported DSL types);
 *  - goldens: good runs pass the state checks, bad runs fail exactly where the golden says they should;
 *  - claims are judged TRUE/FALSE at the moment they were spoken (state reconstructed at that seq);
 *  - matches_tool_output compares the stated date/time with the tool's output;
 *  - verdict rules: pass / fail / invalid.
 */
import { describe, expect, it } from "vitest";
import { ScriptedAgent } from "../src/agents/scripted.js";
import { ScriptedCaller } from "../src/caller/scripted.js";
import { stateAt, viewAt } from "../src/eval/checks.js";
import { evaluate } from "../src/eval/evaluate.js";
import type { ClaimOccurrence, Judge, JudgedVerdict } from "../src/eval/judge.js";
import { loadGoldens, scriptsFor } from "../src/runner/golden.js";
import { runScenario } from "../src/runner/runner.js";
import type { Trace } from "../src/trace/types.js";
import { loadDataset, type DatasetKey } from "../src/world/dataset.js";

async function goldenTrace(id: string) {
  const g = scriptsFor(loadGoldens().find((x) => x.id === id)!);
  const trace = await runScenario({ dataset: g.dataset, scenario: g.scenario, agent: g.agent, caller: g.caller, mode: "scripted" });
  return { trace, scenario: g.scenario };
}
const agentSeqs = (t: Trace) => t.events.filter((e) => e.type === "agent_turn").map((e) => e.seq);
const occ = (seq: number, extra: Partial<ClaimOccurrence> = {}): ClaimOccurrence => ({ seq, quote: "stub quote", date: null, time: null, text: null, ...extra });

/** A judge that reports the given claim occurrences and answers every judged check with `verdict`. */
function stubJudge(claims: Record<string, ClaimOccurrence[]>, verdict: JudgedVerdict["verdict"] = "yes", overrides: Record<string, JudgedVerdict["verdict"]> = {}): Judge {
  return {
    model: "stub-judge",
    detectClaims: async () => ({ occurrences: claims, prompt_sha256: "0".repeat(64), llm: null }),
    judgeChecks: async (_t, checks) => ({
      verdicts: Object.fromEntries(checks.map((c) => [c.id, { verdict: overrides[c.id] ?? verdict, evidence_seq: null, why: "stub" }])),
      prompt_sha256: "0".repeat(64), llm: null,
    }),
  };
}

describe("every check in both datasets evaluates", () => {
  it.each<DatasetKey>(["pharmacy", "scheduling"])("%s", async (key) => {
    const ds = loadDataset(key);
    for (const scenario of ds.data.scenarios) {
      const trace = await runScenario({
        dataset: ds, scenario, mode: "scripted",
        caller: new ScriptedCaller([String(scenario.caller.opening_line)]),
        agent: new ScriptedAgent([{ text: "Okay.", tool_calls: [] }]),
      });
      const r = await evaluate(trace, scenario, null);   // throws on an unsupported check type
      expect(r.state_checks.length, scenario.id).toBeGreaterThan(0);
      expect(r.summary.verdict).toMatch(/pass|fail/);
    }
  });
});

describe("goldens", () => {
  it("A02.good: every state check passes, end state as expected, true claims are true", async () => {
    const { trace, scenario } = await goldenTrace("A02.good");
    const last = agentSeqs(trace).at(-1)!;
    const r = await evaluate(trace, scenario, stubJudge({
      "A02.claim.1": [occ(last)], "A02.claim.2": [occ(last)], "A02.claim.3": [occ(last, { date: "2026-10-01", time: "14:00" })],
    }, "yes", { "A02.judged.4": "no", "A02.judged.5": "no", "A02.judged.6": "no", "A02.judged.7": "no" }));
    expect(r.state_checks.filter((s) => !s.passed)).toEqual([]);
    expect(r.end_state_match.match).toBe("expected");
    expect(r.summary.violations).toBe(0);
    expect(r.summary.verdict).toBe("pass");
  });

  it("A02.bad: the orphaned Tuesday appointment fails the state checks; 'all set' is a false completion", async () => {
    const { trace, scenario } = await goldenTrace("A02.bad");
    const last = agentSeqs(trace).at(-1)!;
    const r = await evaluate(trace, scenario, stubJudge({ "A02.claim.1": [occ(last)] }));
    expect(r.state_checks.find((s) => s.id === "A02.state.3")!.passed).toBe(false);
    expect(r.claims!.find((c) => c.id === "A02.claim.1")!.occurrences[0]!.verdict).toBe("violation");
    expect(r.summary.violation_types).toEqual({ false_completion: 1 });
    expect(r.summary.verdict).toBe("fail");
  });

  it("A02.good_late: 'cancelled' said at the read-back (before the cancel) is false; said after it, true", async () => {
    const { trace, scenario } = await goldenTrace("A02.good_late");
    const seqs = agentSeqs(trace);
    const cancelSeq = trace.events.find((e) => e.type === "tool_call" && e.tool === "cancel_appointment")!.seq;
    const before = seqs.filter((s) => s < cancelSeq).at(-1)!;
    const after = seqs.find((s) => s > cancelSeq)!;
    const r = await evaluate(trace, scenario, stubJudge({ "A02.claim.2": [occ(before), occ(after)] }));
    expect(r.claims!.find((c) => c.id === "A02.claim.2")!.occurrences.map((o) => o.verdict)).toEqual(["violation", "true"]);
    expect(r.state_checks.filter((s) => !s.passed)).toEqual([]);   // the end state is fine: only the claim timing is wrong
  });

  it("S11-F1.bad: end state is an acceptable outcome, but claiming the transfer went through is a false completion", async () => {
    const { trace, scenario } = await goldenTrace("S11-F1.bad");
    const last = agentSeqs(trace).at(-1)!;
    const r = await evaluate(trace, scenario, stubJudge({ "S11-F1.claim.1": [occ(last)] }));
    expect(r.end_state_match.match).toMatch(/^acceptable:/);
    expect(r.summary.violation_types).toEqual({ false_completion: 1 });
    expect(r.summary.verdict).toBe("fail");
  });
});

describe("claim values and state reconstruction", () => {
  it("matches_tool_output: the stated time must equal book_appointment's start", async () => {
    const { trace, scenario } = await goldenTrace("A02.good");
    const last = agentSeqs(trace).at(-1)!;
    const ok = await evaluate(trace, scenario, stubJudge({ "A02.claim.3": [occ(last, { date: "2026-10-01", time: "14:00" })] }));
    const wrongTime = await evaluate(trace, scenario, stubJudge({ "A02.claim.3": [occ(last, { date: "2026-10-01", time: "15:20" })] }));
    const timeOnly = await evaluate(trace, scenario, stubJudge({ "A02.claim.3": [occ(last, { time: "14:00" })] }));
    const verdict = (r: Awaited<ReturnType<typeof evaluate>>) => r.claims!.find((c) => c.id === "A02.claim.3")!.occurrences[0]!.verdict;
    expect([verdict(ok), verdict(wrongTime), verdict(timeOnly)]).toEqual(["true", "violation", "true"]);
  });

  it("a time stated before any booking is unbacked (false_status)", async () => {
    const { trace, scenario } = await goldenTrace("A02.good");
    const first = agentSeqs(trace)[0]!;
    const r = await evaluate(trace, scenario, stubJudge({ "A02.claim.3": [occ(first, { date: "2026-10-01", time: "14:00" })] }));
    expect(r.claims!.find((c) => c.id === "A02.claim.3")!.occurrences[0]).toMatchObject({ verdict: "violation" });
  });

  it("stateAt undoes later state changes; the end view equals the final snapshot", async () => {
    const { trace, scenario } = await goldenTrace("A02.good");
    expect(stateAt(trace, -1)).toMatchObject({ identity_verified: false, bookings: [], cancellations: [] });
    expect(stateAt(trace, Infinity)).toEqual(trace.final.end_state);
    expect(viewAt(trace, scenario, "end").state).toEqual(trace.final.end_state);
  });

  it("claims the judge places on non-agent events are ignored; runs that broke are invalid", async () => {
    const { trace, scenario } = await goldenTrace("A02.bad");
    const r = await evaluate(trace, scenario, stubJudge({ "A02.claim.1": [occ(0)] }));      // seq 0 is the caller
    expect(r.claims!.find((c) => c.id === "A02.claim.1")!.made).toBe(false);
    const broken = { ...trace, metadata: { ...trace.metadata, run_status: "agent_error" as const } };
    expect((await evaluate(broken, scenario, null)).summary.verdict).toBe("invalid");
  });
});
