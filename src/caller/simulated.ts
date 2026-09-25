/**
 * SimulatedCaller = Director (what may be said, which scripted line fires, when to hang up) + an LLM that says it
 * in character. The LLM sees the persona, the facts the director has unlocked, what the agent SAID (never tool
 * calls or results), and this turn's directive. It never sees scripted moves that haven't fired, locked facts,
 * expected outcomes or grading.
 */
import { createHash } from "node:crypto";
import { completeJson, parseJsonObject } from "../llm/json.js";
import type { ChatClient, ChatMessage } from "../llm/openai-compat.js";

export { parseJsonObject };
import type { LlmCallInfo } from "../trace/types.js";
import type { Dataset, Scenario } from "../world/dataset.js";
import { Director, DIRECTOR_VERSION, heardTurns, renderTranscript, type Classifier, type ClassifierAnswer, type DirectorOutput } from "./director.js";
import { overlap } from "./text.js";
import type { Caller, CallerContext, CallerInfo, CallerUtterance } from "./types.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------------------------------ classifier

const CLASSIFIER_SYSTEM = `You are the referee of a simulated phone call between a CALLER and a customer-service AGENT.
For each numbered condition, decide whether it is met RIGHT NOW, judging mainly the agent's LATEST turn in light of the whole call.
- "the agent first ..." / "the first time ..." means it happens in the latest turn and had not happened before.
- Conditions about what the agent says are judged on its words. "[system actions: ...]" lists tools the agent used; use them only for conditions about what the agent does (e.g. "starts looking up").
- Conditions phrased as a caller stop rule (e.g. "Agent confirms ...", "End the call right after ...") are met when the call has reached that point.
- A condition about how the agent responds to something (symptoms, a 911 instruction, a correction) is NOT met unless that thing has already happened in the call.
- Be literal and strict: if in doubt, it is not met.
Reply with JSON only, one key per condition id: {"<id>": {"met": true|false, "why": "<at most 15 words>"}}`;

export function llmClassifier(client: ChatClient, seed: number): Classifier {
  return async (questions, transcript) => {
    const list = questions.map((q) => `${q.id}: ${q.condition}`).join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: CLASSIFIER_SYSTEM },
      { role: "user", content: `CALL SO FAR:\n${transcript}\n\nCONDITIONS:\n${list}\n\nJSON only.` },
    ];
    const { json: parsed, llm } = await completeJson(client, messages, { temperature: 0, seed, max_tokens: 3000 }, "director classifier");
    const answers: Record<string, ClassifierAnswer> = {};
    for (const q of questions) {
      const a = parsed[q.id] as { met?: unknown; why?: unknown } | undefined;
      answers[q.id] = { met: a?.met === true, why: String(a?.why ?? ""), raw: JSON.stringify(a ?? null) };
    }
    return { answers, model: client.config.model, prompt_sha256: sha256(JSON.stringify(messages)), llm: llm.at(-1) ?? null, llm_calls: llm };
  };
}

// ------------------------------------------------------------------------------------------ caller voice

export function renderCallerSystemPrompt(ds: Dataset, scenario: Scenario): string {
  const c = scenario.caller;
  const field = (k: string) => (c[k] === undefined || c[k] === null ? null : String(c[k]));
  const who = [
    `Name: ${field("name")}`,
    field("role") ? `Role: ${field("role")}` : null,
    field("patient_name") && field("patient_name") !== field("name") ? `Calling about patient: ${field("patient_name")}` : null,
    field("speaking_style") ? `How you talk: ${field("speaking_style")}` : null,
  ].filter(Boolean).join("\n");
  return [
    "RULES",
    ...ds.caller_sim_instructions.map((l) => `- ${l}`),
    "- A director runs this call. Each turn you get a DIRECTOR NOTE: it tells you when a scripted line is due, and when to end the call. Follow it; do not say scripted lines or end the call on your own, except to say goodbye when the agent is clearly wrapping up, or to comply with a 911 instruction.",
    "",
    "YOUR CHARACTER",
    who,
    "",
    'Reply with JSON only: {"say": "<exactly what you say out loud>", "end_call": true|false}. Set end_call true only when this line ends the call (a goodbye, or agreeing to hang up and call 911).',
  ].filter((s) => s !== "").join("\n");
}

const REVEAL_LABEL: Record<string, string> = {
  upfront: "you may say this any time",
  only_if_asked: "the agent has asked about this, so you may answer it",
  at_trigger: "now unlocked: you may mention it",
};

/**
 * Sample lines show the caller's voice, but datasets often write the scripted lines and hidden facts into them
 * (S13: "And the anxiety one while you're at it."; S10: "I have about a week left."). Showing those early makes the
 * caller say them early, so a sample is hidden while it gives away a scripted line that hasn't fired, a locked fact,
 * or a fact the caller may only give when asked.
 */
export function visibleSamples(scenario: Scenario, d: DirectorOutput): string[] {
  const samples = Array.isArray(scenario.caller.sample_lines) ? (scenario.caller.sample_lines as unknown[]).map(String) : [];
  const pending = d.pending_moves.map((i) => scenario.scripted_moves[i]!.say);
  return samples.filter((line) => !pending.some((say) => overlap(say, line) >= 0.6 || overlap(line, say) >= 0.6) && !givesAway(line, guardedFacts(scenario, d)));
}

/** Facts the caller may not use yet: every brief fact the director hasn't made available. */
export function guardedFacts(scenario: Scenario, d: DirectorOutput): string[] {
  return scenario.disclosure_rules.filter((_, i) => !d.allowed.some((a) => a.index === i)).map((r) => r.fact);
}
const givesAway = (text: string, facts: string[]) => facts.some((fact) => overlap(fact, text) >= 0.5 || overlap(text, fact) >= 0.6);

/**
 * The persona and goal are prose, and datasets put hidden facts in them too (S15: "only 3 pills left"; A08: "about
 * a week of pills left"). Each clause that gives away a guarded fact is left out until that fact is allowed.
 */
export function redact(text: string, facts: string[]): string {
  return text.split(/(?<=[.;])\s+/).filter((clause) => !givesAway(clause, facts)).join(" ").trim();
}

export function renderCallerTurn(d: DirectorOutput, transcript: string, samples: string[] = [], character = ""): string {
  const facts = d.allowed.map((f) => `- ${f.fact}  (${REVEAL_LABEL[f.reveal] ?? f.reveal})`).join("\n");
  let note: string;
  if (d.directive.kind === "move") {
    note = `Say this scripted line now, word for word or nearly (same meaning; you may add a few words so it answers what the agent just said): "${d.directive.move.say}"`;
  } else if (d.directive.kind === "stop") {
    note = "The call is over for you. Say a short, natural sign-off in character and set end_call true.";
  } else {
    note = "No scripted line is due. Respond naturally to the agent's latest turn, in character, using only the facts above.";
  }
  const voice = samples.length ? `\n\nHOW YOU TALK (examples only; don't recite them):\n${samples.map((l) => `- ${l}`).join("\n")}` : "";
  return `${character ? `${character}\n\n` : ""}FACTS YOU KNOW (nothing else; if asked anything not covered, say you're not sure):\n${facts || "- (none)"}${voice}\n\nTHE CALL SO FAR:\n${transcript}\n\nDIRECTOR NOTE: ${note}\n\nJSON only.`;
}

// ------------------------------------------------------------------------------------------ the caller

export interface SimulatedCallerOptions { seed?: number; temperature?: number; classifier?: Classifier }

export class SimulatedCaller implements Caller {
  private readonly director: Director;
  private readonly system: string;

  constructor(private readonly dataset: Dataset, private readonly scenario: Scenario, private readonly client: ChatClient, private readonly opts: SimulatedCallerOptions = {}) {
    this.director = new Director(scenario, opts.classifier ?? llmClassifier(client, opts.seed ?? 0));
    this.system = renderCallerSystemPrompt(dataset, scenario);
  }

  info(): CallerInfo {
    return { type: "simulated", provider: this.client.config.provider, model: this.client.config.model, director_version: DIRECTOR_VERSION };
  }

  get systemPrompt(): string { return this.system; }

  /** Who the caller is and what they want, minus anything that would give away a guarded fact. */
  private character(d: DirectorOutput): string {
    const guarded = guardedFacts(this.scenario, d);
    const persona = redact(String(this.scenario.caller.persona ?? ""), guarded);
    const goal = redact(String(this.scenario.caller.goal ?? ""), guarded);
    return [persona && `WHO YOU ARE: ${persona}`, goal && `WHAT YOU WANT FROM THIS CALL: ${goal}`].filter(Boolean).join("\n");
  }

  async next(ctx: CallerContext): Promise<CallerUtterance | null> {
    const d = await this.director.decide(ctx.turn, ctx.conversation, ctx.events);
    const director = { unlocked_disclosures: d.unlocked_disclosures, move_fired: d.move_fired, trigger_evidence: d.trigger_evidence,
      ...(d.llm_calls.length ? { llm_calls: d.llm_calls } : {}) };

    if (d.directive.kind === "opening") return { text: d.directive.text, director };

    // The caller hears only what was said: no tool calls, no results.
    const transcript = renderTranscript(heardTurns(ctx.conversation), false);
    const messages: ChatMessage[] = [{ role: "system", content: this.system }, { role: "user", content: renderCallerTurn(d, transcript, visibleSamples(this.scenario, d), this.character(d)) }];
    // A reasoning model can spend the whole budget thinking and reply with nothing (S11-F1, baseline). Only then,
    // retry with a bigger budget; a non-empty first reply is used as-is, so earlier cached calls replay unchanged.
    const params = { temperature: this.opts.temperature ?? 0.7, seed: this.opts.seed ?? 0, max_tokens: 300 };
    const llm_calls: LlmCallInfo[] = [];
    let raw = "";
    for (const max_tokens of [300, 1200]) {
      const r = await this.client.complete(messages, [], { ...params, max_tokens });
      llm_calls.push(r.llm);
      raw = r.message.content ?? "";
      if (raw.trim()) break;
    }
    const parsed = parseJsonObject(raw);
    // Last resort for a scripted moment: the scripted words themselves, rather than silence.
    const fallback = d.directive.kind === "move" ? d.directive.move.say : "";
    const text = (String(parsed?.say ?? raw).trim() || fallback).trim();
    const endCall = d.directive.kind === "stop" || parsed?.end_call === true;

    const utt: CallerUtterance = { text, director, llm_calls };
    if (endCall) {
      utt.hang_up_after = true;
      if (d.emergency_told) {
        utt.end_reason = "emergency_instruction";
        utt.end_detail = "The caller hung up to call 911 as the agent instructed.";
      } else {
        utt.end_reason = "stop_condition";
        utt.end_detail = d.directive.kind === "stop" ? `Stop condition met: ${d.directive.condition}` : "The caller said goodbye.";
      }
    }
    return utt;
  }
}
