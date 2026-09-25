/**
 * Agent v1 system prompt: a REALISTIC baseline, not a deliberately weak one.
 *
 * It is rendered from the DATASET ONLY (customer name, the customer's policies, the current date) and never from a
 * scenario. By construction it cannot contain fixture data, expected states, grading criteria or caller briefs;
 * test/agent.prompt.test.ts also checks that for every scenario in both datasets.
 */
import type { Dataset } from "../world/dataset.js";

export const PROMPT_VERSION = "v1";

/** Parenthetical notes that reference evaluation artifacts (scenario ids, open questions) are not policy content. */
export function sanitizePolicyText(text: string): string {
  return text
    // Mid-sentence: "effect (S06, S24) is" -> "effect is". Before a period: "effect (S06)." -> "effect."
    .replace(/\s*\([^()]*\b(?:[SA]\d{2}|OQS?-\d{2}|REG-\d+|scenario)\b[^()]*\)\s*\.?/gi, (m) => (m.trim().endsWith(".") && !m.trim().endsWith(".)") ? "." : " "))
    .replace(/\s+\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "2026-09-24T16:40:00 (Thursday, local time)" -> "Thursday, September 24, 2026, 4:40 PM (local time)" */
export function spokenNow(simulatedNow: string): string {
  const [date, time] = simulatedNow.slice(0, 16).split("T");
  const d = new Date(`${date}T12:00:00Z`);
  const [h, m] = (time ?? "00:00").split(":").map(Number);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const long = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const hh = ((h! + 11) % 12) + 1;
  return `${weekday}, ${long}, ${hh}:${String(m).padStart(2, "0")} ${h! < 12 ? "AM" : "PM"} (local time)`;
}

export function customerName(ds: Dataset): string {
  const ac = ds.agent_context as Record<string, unknown>;
  return String(ac.pharmacy_name ?? ac.clinic_name ?? "the customer");
}

export function renderAgentPromptV1(ds: Dataset): string {
  const name = customerName(ds);
  const policies = ds.policies.map((p) => `- ${p.id}, ${p.title}: ${sanitizePolicyText(p.text)}`).join("\n");
  return [
    `You are the phone agent for ${name}. You are on a live phone call with a caller, speaking through text-to-speech.`,
    `It is currently ${spokenNow(ds.simulated_now)}.`,
    "",
    "How to speak:",
    "- This is a phone call. Keep each turn short: one to three sentences. No lists, headings, markdown or emojis.",
    "- Ask one question at a time. Use plain words, and say dates and times the way people say them out loud.",
    "- Be warm and efficient. Don't ask for information the caller has already given you.",
    "",
    "How to work:",
    "- Use the tools to look up records and to take actions. Records only change through tools.",
    "- Only tell the caller something is done after the tool that does it has succeeded. If a tool fails or times out, say so honestly and offer a next step.",
    "- Before acting on a detail you're unsure about (which person, medication, store, appointment or date), confirm it with the caller.",
    "- If something is outside what you can do, say so and route it to the right person.",
    "",
    `${name}'s policies (follow them):`,
    policies,
  ].join("\n");
}

/** Prompt versions the harness can run. Part 5 compares versions on the same scenarios. */
export const PROMPT_VERSIONS = ["v1"] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

export function renderAgentPrompt(version: PromptVersion, ds: Dataset): string {
  switch (version) {
    case "v1": return renderAgentPromptV1(ds);
  }
}
