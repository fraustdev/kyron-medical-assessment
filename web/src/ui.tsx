import { useEffect, useState, type ReactNode } from "react";
import type { RunRow } from "./api";

export function useFetch<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load().then((d) => { if (live) setData(d); }).catch((e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const VERDICT: Record<string, { label: string; glyph: string }> = {
  pass: { label: "Passed", glyph: "✓" },
  fail: { label: "Failed", glyph: "✗" },
  invalid: { label: "Broken run", glyph: "!" },
};

export function Verdict({ v, overridden, size }: { v: string | null; overridden?: boolean; size?: "lg" }) {
  const d = v ? VERDICT[v] : null;
  return (
    <span className={`verdict v-${v ?? "none"} ${size === "lg" ? "lg" : ""}`} title={overridden ? "Set by a human reviewer" : undefined}>
      <span aria-hidden>{d?.glyph ?? "–"}</span> {d?.label ?? "Not scored"}{overridden ? <span className="by-human"> by reviewer</span> : null}
    </span>
  );
}

export function Loading({ error }: { error: string | null }) {
  return error
    ? <div className="notice bad">The app couldn't reach its server: {error}. Check that <code>npm run serve</code> is running.</div>
    : <div className="notice muted">Loading…</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><p className="empty-title">{title}</p>{children ? <div className="empty-body">{children}</div> : null}</div>;
}

export function Bar({ value, max, tone }: { value: number; max: number; tone?: "fail" | "pass" }) {
  return <div className="bar" role="presentation"><div className={`bar-fill ${tone ?? ""}`} style={{ width: `${max ? (value / max) * 100 : 0}%` }} /></div>;
}

// ------------------------------------------------------------------------------------------ the call strip

const END_LABEL: Record<string, string> = {
  stop_condition: "caller hung up",
  emergency_instruction: "caller hung up to call 911",
  transfer: "transferred",
  turn_cap: "ran out of turns",
  agent_hangup: "agent hung up",
};

/**
 * The whole call on one line: caller turns above, agent turns below, tool calls on the line (red when they
 * failed), and a red marker wherever a finding points. Clickable on the run page.
 */
export function CallStrip({ strip, onPick, large }: { strip: RunRow["strip"]; onPick?: (seq: number) => void; large?: boolean }) {
  const n = strip.items.length;
  if (n === 0) return <div className="strip empty-strip">no conversation</div>;
  const problems = new Set(strip.problems);
  const describe = (it: RunRow["strip"]["items"][number]) =>
    `Turn ${it.turn + 1}: ${it.kind === "caller" ? "caller speaks" : it.kind === "agent" ? "agent speaks" : it.ok ? "system action succeeded" : "system action failed"}${it.fault ? " (injected fault)" : ""}${problems.has(it.seq) ? ", flagged by a finding" : ""}`;
  return (
    <div className={`strip ${large ? "large" : ""}`} aria-label={`Call with ${n} events${strip.problems.length ? `, ${strip.problems.length} flagged` : ""}`}>
      <div className="strip-line" />
      {strip.items.map((it, i) => {
        const left = `${((i + 0.5) / n) * 100}%`;
        const cls = `strip-mark ${it.kind} ${it.kind === "tool" ? (it.ok ? "ok" : "err") : ""} ${it.fault ? "fault" : ""} ${problems.has(it.seq) ? "flagged" : ""}`;
        return onPick
          ? <button key={it.seq} className={cls} style={{ left }} title={describe(it)} aria-label={describe(it)} onClick={() => onPick(it.seq)} />
          : <span key={it.seq} className={cls} style={{ left }} title={describe(it)} />;
      })}
      {strip.end && <span className={`strip-end ${strip.end}`} title={`Call ended: ${END_LABEL[strip.end] ?? strip.end}`} />}
    </div>
  );
}

export const endLabel = (reason: string | null) => (reason ? END_LABEL[reason] ?? reason.replace(/_/g, " ") : "");

export function StripKey() {
  return (
    <div className="strip-key" aria-hidden>
      <span><i className="k caller" /> caller</span>
      <span><i className="k agent" /> agent</span>
      <span><i className="k tool ok" /> system action</span>
      <span><i className="k tool err" /> failed action</span>
      <span><i className="k flag" /> flagged by a finding</span>
    </div>
  );
}
