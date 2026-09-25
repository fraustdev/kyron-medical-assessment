/** Human-readable rendering of a trace: the transcript interleaved with tool calls and state changes. */
import type { Trace, TraceEvent } from "../trace/types.js";

const short = (v: unknown, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function formatEvent(e: TraceEvent): string | null {
  const t = `${(e.t_ms / 1000).toFixed(1).padStart(6)}s`;
  switch (e.type) {
    case "caller_turn": return `\n${t}  CALLER   ${e.text}`;
    case "agent_turn": return `${t}  AGENT    ${e.text || "(no speech)"}${e.llm ? `   [${e.llm.cache_hit ? "cache" : "live"} ${e.llm.latency_ms}ms]` : ""}`;
    case "tool_call": return `${t}    → ${e.tool}(${short(e.args, 140)})`;
    case "tool_result": return `${t}    ← ${e.result_code}${e.fault_applied ? ` [FAULT ${e.fault_applied.behavior}${e.fault_applied.committed !== undefined ? ` committed=${e.fault_applied.committed}` : ""}]` : ""}  ${short(e.result, 140)}`;
    case "state_change": return `${t}      Δ ${e.collection} ${e.op}: ${short(e.after, 120)}`;
    case "director_decision": {
      const head = `${t}    ◆ director: ${e.move_fired ? `move ${e.move_fired.index} fires` : "no move"}${e.unlocked_disclosures.length ? `, unlocks fact ${e.unlocked_disclosures.map((d) => d.index).join(",")}` : ""}`;
      const why = e.trigger_evidence.map((v) => `${" ".repeat(t.length)}        · ${v.kind}: ${v.kind === "llm_check" ? v.question : v.description}`);
      return [head, ...why].join("\n");
    }
    case "error": return `${t}    ! ${e.source} error${e.fatal ? " (fatal)" : ""}: ${e.message}`;
    case "call_end": return `${t}  ■ CALL END (${e.reason}) ${e.detail}${e.handoff ? `  handoff→${e.handoff.to}` : ""}`;
  }
}

export function formatTrace(trace: Trace): string {
  const m = trace.metadata;
  const head = [
    `run ${m.run_id}`,
    `scenario ${m.scenario_id} · ${m.dataset.name}@${m.dataset.version} · agent ${m.agent.id} (${m.agent.provider ?? "-"}/${m.agent.model ?? "-"}) · caller ${m.caller.type} · mode ${m.mode}`,
    `status ${m.run_status} · turns ${trace.final.counts.turns} · tool calls ${trace.final.counts.tool_calls} · errors ${trace.final.counts.errors}`,
  ];
  const body = trace.events.map(formatEvent).filter((x): x is string => x !== null);
  const end = Object.entries(trace.final.end_state).map(([k, v]) => `  ${k}: ${short(v, 200)}`);
  return [...head, ...body, "", "END STATE", ...end].join("\n");
}
