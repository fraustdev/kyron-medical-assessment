import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ReviewItem, type RunDetail as Detail } from "../api";
import { Link } from "../router";
import { CallStrip, endLabel, Loading, plural, StripKey, useFetch, Verdict } from "../ui";

type Ev = Detail["trace"]["events"][number];
type Eval = NonNullable<Detail["eval"]>;

// ------------------------------------------------------------------------------------------ page

export function RunDetail({ runId }: { runId: string }) {
  const { data, error, reload } = useFetch(() => api.run(runId), [runId]);
  const [focus, setFocus] = useState<{ seq: number; n: number } | null>(null);
  const [show, setShow] = useState({ actions: true, script: false });

  const jump = (seq: number) => setFocus((f) => ({ seq, n: (f?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focus) return;
    document.getElementById(`ev-${focus.seq}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  }, [focus]);

  /** Event seq -> the conversational turn it belongs to (1-based), for "Turn 4" links. */
  const turnOf = useMemo(() => new Map((data?.trace.events ?? []).map((e) => [e.seq, e.turn + 1])), [data]);

  if (!data) return <Loading error={error} />;
  const { run, trace, eval: ev, scenario, review, story } = data;
  const m = trace.metadata;
  const runItem = review.find((r) => r.item_id === "run");
  const TurnLink = ({ seq }: { seq: number }) => <button className="turnlink" onClick={() => jump(seq)}>Turn {turnOf.get(seq) ?? "?"}</button>;
  const callerSeqOfTurn = (turn: number) => trace.events.find((e) => e.type === "caller_turn" && e.turn === turn - 1)?.seq;

  return (
    <div className="page detail">
      <Link to={`/calls?batch=${encodeURIComponent(run.batch)}`} className="back">All calls in {run.batch}</Link>

      <div className="run-head">
        <div className="run-title">
          <span className="sid">{m.scenario_id}</span>
          <h1>{String(scenario?.title ?? m.scenario_id)}</h1>
          <p className="lede small-lede"><Verdict v={run.effective_verdict} overridden={run.overridden} size="lg" /> <VerdictSentence ev={ev} status={m.run_status} /></p>
        </div>
        {runItem && (
          <div className="run-review">
            <ReviewControl runId={runId} item={runItem} label="Your verdict on this call" onSaved={reload} />
            {runItem.human && runItem.human.human_passed !== runItem.auto_passed
              ? <p className="sub">The automatic grade was {runItem.auto_passed ? "pass" : "fail"}. Your verdict is the one shown across the app.</p>
              : <p className="sub">Agree or disagree with the automatic grade. Your verdict replaces it everywhere.</p>}
          </div>
        )}
      </div>

      <section className="story" aria-label="Summary of this call">
        <div>
          <h2>The test</h2>
          <p>{story.test}</p>
          {story.catch && <p className="sub">{story.catch}</p>}
        </div>
        <div>
          <h2>What a correct agent does</h2>
          <p>{story.should}</p>
          <p className="sub">From the scenario's answer key.</p>
        </div>
        <div>
          <h2>What actually happened</h2>
          <ul>{story.happened.map((h, i) => <li key={i}>{h}</li>)}</ul>
        </div>
        {story.checkpoints && (
          <div className="checkpoints">
            <h2>Scripted moments</h2>
            <p className="sub">The caller is scripted to say these lines when the agent reaches each point. A moment that never happened means the call went a different way.</p>
            <ol>
              {story.checkpoints.map((c) => {
                const seq = c.turn !== null ? callerSeqOfTurn(c.turn) : undefined;
                return (
                  <li key={c.index} className={c.reached ? "reached" : "missed"}>
                    <span className="cp-mark" aria-hidden>{c.reached ? "✓" : "–"}</span>
                    <span className="cp-body">“{c.say}”<span className="sub"> {c.reached ? "Happened" : "Never happened"}: when {c.trigger}.</span></span>
                    {seq !== undefined && <TurnLink seq={seq} />}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </section>

      <div className="strip-panel">
        <p className="strip-caption">The whole call at a glance, start to finish. Click any mark to jump to that moment.</p>
        <CallStrip strip={run.strip} onPick={jump} large />
        <StripKey />
      </div>

      {scenario && <ScenarioBrief scenario={scenario} />}

      <div className="split">
        <section className="call" aria-label="The call">
          <div className="section-head">
            <h2>The call</h2>
            <div className="toggles">
              <label><input type="checkbox" checked={show.actions} onChange={() => setShow({ ...show, actions: !show.actions })} /> System actions</label>
              <label><input type="checkbox" checked={show.script} onChange={() => setShow({ ...show, script: !show.script })} /> Simulator's reasoning</label>
            </div>
          </div>
          <p className="panel-help">Everything said, in order. The indented lines are the agent using the pharmacy or clinic system, which the caller can't see. Click one to see what was sent and returned.</p>
          <Timeline events={trace.events} focus={focus} show={show} />
        </section>
        <section className="findings" aria-label="How the call was graded">
          <div className="section-head"><h2>How it was graded</h2></div>
          <p className="panel-help">Failures first. “Turn” buttons jump to the moment in the call. Use Pass and Fail to record whether you agree.</p>
          {ev ? <Findings ev={ev} review={review} runId={runId} TurnLink={TurnLink} onSaved={reload} />
            : <div className="empty"><p className="empty-title">This call hasn't been graded yet.</p><div className="empty-body">Grade it with <code>npx tsx src/cli/evaluate.ts {run.trace_path}</code>, then reload.</div></div>}
        </section>
      </div>

      <details className="tech">
        <summary>Technical details</summary>
        <dl className="facts compact">
          <div><dt>Agent being tested</dt><dd>{m.agent.version}, {m.agent.provider}/{m.agent.model ?? "scripted"}</dd></div>
          <div><dt>Caller</dt><dd>{m.caller.type === "simulated" ? `simulated by ${m.caller.model}` : m.caller.type}</dd></div>
          <div><dt>Conversation judge</dt><dd>{ev?.judge?.model ?? "none"}</dd></div>
          <div><dt>Length</dt><dd>{plural(trace.final.counts.caller_turns, "caller turn")}, {plural(trace.final.counts.tool_calls, "system action")}</dd></div>
          <div><dt>Ending</dt><dd>{endLabel(run.strip.end) || m.run_status}</dd></div>
          <div><dt>Recorded as</dt><dd>{m.mode}, seed {m.seed}, trial {m.trial_index}</dd></div>
          <div><dt>Run id</dt><dd><code>{m.run_id}</code></dd></div>
          <div><dt>Recording file</dt><dd><code>{run.trace_path}</code></dd></div>
        </dl>
      </details>
    </div>
  );
}

function VerdictSentence({ ev, status }: { ev: Eval | null; status: string }) {
  if (!ev) return <span>Not scored yet.</span>;
  const s = ev.summary;
  if (s.verdict === "invalid") return <span>The run broke before the call finished ({status.replace(/_/g, " ")}), so it isn't scored.</span>;
  if (s.verdict === "pass") return <span>Every required outcome was met, nothing the agent claimed was false, and it handled the caller well.</span>;
  const parts: string[] = [];
  const missed = s.state_total - s.state_passed;
  if (missed) parts.push(`${missed} of ${s.state_total} required outcomes not met`);
  if (s.violations) parts.push(plural(s.violations, "false claim"));
  const judgedMissed = s.judged_applicable - s.judged_passed;
  if (judgedMissed) parts.push(`${plural(judgedMissed, "caller-handling check")} failed`);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "Something in the end state was forbidden";
  return <span>{text[0]!.toUpperCase() + text.slice(1)}.</span>;
}

// ------------------------------------------------------------------------------------------ scenario brief

function ScenarioBrief({ scenario }: { scenario: NonNullable<Detail["scenario"]> }) {
  const caller = scenario.caller as Record<string, unknown>;
  const disclosures = scenario.disclosure_rules as { fact: string; reveal: string; trigger?: string }[];
  const moves = scenario.scripted_moves as { trigger: string; say: string }[];
  const faults = scenario.tool_faults as { tool: string; behavior: string; on_call?: unknown }[];
  const reveal = (d: { reveal: string; trigger?: string }) =>
    d.reveal === "upfront" ? "says it up front" : d.reveal === "only_if_asked" ? "only if asked" : `only once ${d.trigger ?? "triggered"}`;
  return (
    <details className="brief">
      <summary>Full scenario brief: the caller's persona, what they know, and every scripted line</summary>
      <div className="brief-grid">
        <div>
          <p><strong>{String(caller.name)}</strong>, {String(caller.role)}. {String(caller.persona ?? "")}</p>
          <p><span className="k-label">Wants to</span> {String(caller.goal ?? "")}</p>
          <p><span className="k-label">Success looks like</span> {scenario.success_summary}</p>
          {faults.length > 0 && <p><span className="k-label">Injected system faults</span> {faults.map((f, i) => <span key={i}><code>{f.tool}</code> {f.behavior.replace(/_/g, " ")}{f.on_call !== undefined ? ` on call ${String(f.on_call)}` : ""}{i < faults.length - 1 ? "; " : ""}</span>)}</p>}
        </div>
        <div>
          <p className="k-label">What the caller knows</p>
          <ul>{disclosures.map((d, i) => <li key={i}>{d.fact} <span className="sub">({reveal(d)})</span></li>)}</ul>
          {moves.length > 0 && <>
            <p className="k-label">Lines the caller is scripted to say</p>
            <ul>{moves.map((mv, i) => <li key={i}>“{mv.say}” <span className="sub">when {mv.trigger}</span></li>)}</ul>
          </>}
        </div>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------------------------------ timeline

function resultWords(code: string | undefined): string {
  if (!code) return "no response";
  if (code === "success") return "succeeded";
  if (code === "timeout") return "timed out";
  return `failed: ${code.replace(/^error:/, "").replace(/_/g, " ")}`;
}

function Timeline({ events, focus, show }: { events: Ev[]; focus: { seq: number; n: number } | null; show: { actions: boolean; script: boolean } }) {
  const results = useMemo(() => new Map(events.flatMap((e) => (e.type === "tool_result" ? [[e.call_id, e] as const] : []))), [events]);
  const changes = useMemo(() => {
    const m = new Map<string, Extract<Ev, { type: "state_change" }>[]>();
    for (const e of events) if (e.type === "state_change") m.set(e.call_id, [...(m.get(e.call_id) ?? []), e]);
    return m;
  }, [events]);
  // A caller line is scripted when the simulator fired a scripted move just before it, in the same turn.
  const scripted = useMemo(() => {
    const out = new Set<number>();
    let pending: number | null = null;
    for (const e of events) {
      if (e.type === "director_decision") pending = e.move_fired ? e.turn : null;
      else if (e.type === "caller_turn") { if (pending === e.turn) out.add(e.seq); pending = null; }
    }
    return out;
  }, [events]);
  const focused = (seq: number, alsoSeq?: number) => focus !== null && (focus.seq === seq || focus.seq === alsoSeq);
  // Re-keying on each jump replays the highlight even when the same turn is picked twice.
  const fk = (seq: number, alsoSeq?: number) => (focused(seq, alsoSeq) ? `f${focus!.n}` : "");
  let lastTurn = -1;

  return (
    <ol className="events">
      {events.map((e): ReactNode => {
        const turnMark = e.type === "caller_turn" && e.turn !== lastTurn ? (lastTurn = e.turn, <li key={`t${e.turn}`} className="turn-mark" aria-hidden>Turn {e.turn + 1}<span>{(e.t_ms / 1000).toFixed(1)}s</span></li>) : null;
        switch (e.type) {
          case "caller_turn":
            return [turnMark, <li key={e.seq + fk(e.seq)} id={`ev-${e.seq}`} className={`msg caller ${focused(e.seq) ? "focused" : ""}`}><span className="who">Caller{scripted.has(e.seq) ? <span className="scripted-tag" title="The scenario scripts this line for this moment. Everything else the caller says is improvised."> scripted moment</span> : null}</span><p>{e.text}</p></li>];
          case "agent_turn":
            return <li key={e.seq + fk(e.seq)} id={`ev-${e.seq}`} className={`msg agent ${focused(e.seq) ? "focused" : ""}`}><span className="who">Agent{e.llm ? <span className="latency"> replied in {(e.llm.latency_ms / 1000).toFixed(1)}s</span> : null}</span><p>{e.text || <i className="sub">(said nothing)</i>}</p></li>;
          case "tool_call": {
            if (!show.actions) return null;
            const r = results.get(e.call_id);
            const ok = r?.result_code === "success";
            const ch = changes.get(e.call_id) ?? [];
            return (
              <li key={e.seq + fk(e.seq, r?.seq)} id={`ev-${e.seq}`} className={`action ${ok ? "ok" : "err"} ${focused(e.seq, r?.seq) ? "focused" : ""}`}>
                <details open={focused(e.seq, r?.seq)}>
                  <summary>
                    <span className="sub">Used </span><code>{e.tool}</code> <span className={ok ? "" : "bad"}>{resultWords(r?.result_code)}</span>
                    {r?.fault_applied && <span className="flag-fault" title="Injected by the scenario to test the agent">injected fault</span>}
                    {ch.length > 0 && <span className="sub"> and changed {ch.map((c) => c.collection.replace(/_/g, " ")).join(", ")}</span>}
                  </summary>
                  <div id={r ? `ev-${r.seq}` : undefined} className="action-body">
                    <p className="k-label">Sent</p><pre>{JSON.stringify(e.args, null, 2)}</pre>
                    <p className="k-label">Got back</p><pre>{JSON.stringify(r?.result ?? null, null, 2)}</pre>
                    {ch.map((c) => <p key={c.seq} className="sub">Record change: {c.collection.replace(/_/g, " ")} {c.op}, <code>{JSON.stringify(c.after)}</code></p>)}
                  </div>
                </details>
              </li>
            );
          }
          case "director_decision": {
            if (!show.script) return null;
            if (!e.move_fired && e.unlocked_disclosures.length === 0 && e.trigger_evidence.length === 0) return null;
            return (
              <li key={e.seq} id={`ev-${e.seq}`} className="script">
                <details>
                  <summary>
                    {e.move_fired ? <>Caller script: say line {e.move_fired.index + 1}, “{e.move_fired.say}”</> : "Caller script: no scripted line"}
                    {e.unlocked_disclosures.length > 0 && <>; may now mention {e.unlocked_disclosures.map((d) => `“${d.fact}”`).join(", ")}</>}
                  </summary>
                  <ul>{e.trigger_evidence.map((v, i) => <li key={i}>{v.kind === "llm_check" ? <>Judged true by {v.model}: {v.question.replace(/^\[[^\]]+\]\s*/, "")}</> : v.kind === "tool_event" ? <>From the records: {v.description}</> : v.kind === "turn_count" ? <>Turn count: {v.description}</> : v.description}</li>)}</ul>
                </details>
              </li>
            );
          }
          case "error":
            return <li key={e.seq} id={`ev-${e.seq}`} className="sysline bad">{e.fatal ? "The run stopped" : "Warning"}: {e.message}</li>;
          case "call_end":
            return <li key={e.seq} id={`ev-${e.seq}`} className="sysline">Call ended: {endLabel(e.reason)}.{e.handoff ? ` Handed off to ${e.handoff.to}.` : ""}</li>;
          default:
            return null;
        }
      })}
    </ol>
  );
}

// ------------------------------------------------------------------------------------------ findings

type TurnLinkT = (p: { seq: number }) => ReactNode;

function Findings({ ev, review, runId, TurnLink, onSaved }: { ev: Eval; review: ReviewItem[]; runId: string; TurnLink: TurnLinkT; onSaved: () => void }) {
  const item = (id: string) => review.find((r) => r.item_id === id)!;
  const byFailFirst = <T,>(xs: T[], passed: (x: T) => boolean) => [...xs].sort((a, b) => Number(passed(a)) - Number(passed(b)));
  const seqLinks = (text: string) => text.split(/(seq \d+)/g).map((p, i) => { const m = /^seq (\d+)$/.exec(p); return m ? <TurnLink key={i} seq={Number(m[1])} /> : <span key={i}>{p}</span>; });
  const claims = ev.claims ?? [];
  const made = claims.filter((c) => c.made);
  const judged = ev.judged_checks ?? [];

  return (
    <div className="findings-body">
      <FindingGroup title="Required outcomes" how="Checked from the system's records and the log of system actions."
        count={`${ev.summary.state_passed} of ${ev.summary.state_total} met`}>
        {byFailFirst(ev.state_checks, (c) => c.passed).map((c) => (
          <Finding key={c.id} state={c.passed ? "pass" : "fail"} prefix={mustNot(c.kind, c.text)} text={c.text}
            detail={seqLinks(c.detail)} id={c.id} review={<ReviewControl runId={runId} item={item(c.id)} onSaved={onSaved} />} />
        ))}
        {ev.forbidden_state.filter((f) => f.violated).map((f) => <Finding key={f.index} state="fail" prefix="Forbidden:" text={f.reason} detail={f.detail} id={`forbidden-${f.index}`} />)}
      </FindingGroup>

      <FindingGroup title="Things the agent said were done" how={`${ev.judge?.model ?? "The judge"} finds each claim in the agent's words; the records decide whether it was true when it was said.`}
        count={claims.length === 0 ? "none to check" : made.length === 0 ? "none made" : `${ev.summary.violations} false`}>
        {byFailFirst(claims, (c) => c.occurrences.every((o) => o.verdict !== "violation")).map((c) => {
          const bad = c.occurrences.some((o) => o.verdict === "violation");
          return (
            <Finding key={c.id} state={!c.made ? "neutral" : bad ? "fail" : "pass"} text={c.claim}
              detail={!c.made ? "The agent never said this." : (
                <ul className="said">{c.occurrences.map((o, i) => (
                  <li key={i}><TurnLink seq={o.seq} /> “{o.quote}” <span className={`said-${o.verdict}`}>{o.verdict === "violation" ? `false (${c.violation_type.replace(/_/g, " ")})` : o.verdict === "true" ? "true" : "caused by an injected fault, not the agent"}</span><div className="sub">{o.detail}</div></li>
                ))}</ul>
              )}
              id={c.id} review={<ReviewControl runId={runId} item={item(c.id)} onSaved={onSaved} />} />
          );
        })}
      </FindingGroup>

      <FindingGroup title="How the agent handled the caller" how={`Judged by ${ev.judge?.model ?? "an LLM"} from the transcript and system actions.`}
        count={`${ev.summary.judged_passed} of ${ev.summary.judged_applicable} passed`}>
        {byFailFirst(judged, (j) => j.passed || j.verdict === "n/a").map((j) => (
          <Finding key={j.id} state={j.verdict === "n/a" ? "neutral" : j.passed ? "pass" : "fail"} prefix={mustNot(j.kind, j.text)} text={j.text}
            detail={<>{j.verdict === "n/a" ? "Didn't come up. " : ""}{j.why} {j.evidence_seq !== null && <TurnLink seq={j.evidence_seq} />}</>}
            id={j.id} review={<ReviewControl runId={runId} item={item(j.id)} onSaved={onSaved} />} />
        ))}
      </FindingGroup>
    </div>
  );
}

function FindingGroup({ title, how, count, children }: { title: string; how: string; count: string; children: ReactNode }) {
  return (
    <section className="group">
      <div className="group-head"><h3>{title}</h3><span className="group-count">{count}</span></div>
      <p className="how">{how}</p>
      <ul className="finding-list">{children}</ul>
    </section>
  );
}

/** "Must not:" only when the check's own wording doesn't already say it ("The agent does not retry..."). */
const mustNot = (kind: string, text: string) => (kind === "must_not_do" && !/\b(not|no|never|without)\b/i.test(text.split(" ").slice(0, 6).join(" ")) ? "Must not:" : undefined);

function Finding({ state, prefix, text, detail, id, review }: { state: "pass" | "fail" | "neutral"; prefix?: string; text: string; detail: ReactNode; id: string; review?: ReactNode }) {
  return (
    <li className={`finding ${state}`}>
      <span className="mark" aria-label={state === "pass" ? "passed" : state === "fail" ? "failed" : "not applicable"}>{state === "pass" ? "✓" : state === "fail" ? "✗" : "–"}</span>
      <div className="finding-main">
        <p className="finding-text" title={id}>{prefix && <span className="prefix">{prefix} </span>}{text}</p>
        <div className="finding-detail">{detail}</div>
      </div>
      {review}
    </li>
  );
}

// ------------------------------------------------------------------------------------------ human review

function ReviewControl({ runId, item, label, onSaved }: { runId: string; item: ReviewItem; label?: string; onSaved: () => void }) {
  const [note, setNote] = useState(item.human?.note ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => setNote(item.human?.note ?? ""), [item.human?.note]);
  const human = item.human ? item.human.human_passed : null;
  const save = async (v: boolean | null, n = note) => {
    setSaving(true);
    try { await api.label(runId, item.item_id, v, n); onSaved(); } finally { setSaving(false); }
  };
  const overrides = human !== null && human !== item.auto_passed;
  return (
    <div className={`review ${label ? "big" : ""}`}>
      {label ? <span className="review-label">{label}{overrides ? <span className="overrides"> (overrides the evaluator)</span> : null}</span>
        : overrides ? <span className="review-label overrides">Your call overrides</span> : null}
      <div className="seg" role="group" aria-label={label ?? "Your verdict on this finding"} title="Your verdict on this finding">
        <button disabled={saving} aria-pressed={human === true} className={human === true ? "on pass" : ""} onClick={() => save(human === true ? null : true)}>Pass</button>
        <button disabled={saving} aria-pressed={human === false} className={human === false ? "on fail" : ""} onClick={() => save(human === false ? null : false)}>Fail</button>
      </div>
      {human !== null && (
        <input className="note" aria-label="Note" placeholder="Add a note" value={note} onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if (note !== (item.human?.note ?? "")) void save(human, note); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      )}
    </div>
  );
}
