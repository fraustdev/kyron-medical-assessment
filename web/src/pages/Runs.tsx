import { api, type Batch } from "../api";
import { Link, navigate, useQueryParam } from "../router";
import { CallStrip, Empty, Loading, pct, plural, StripKey, useFetch, Verdict } from "../ui";

function Lede({ b }: { b: Batch }) {
  const scored = b.evaluated - b.invalid;
  if (scored === 0) return <p className="lede">{plural(b.runs, "call")} recorded. None has been scored yet.</p>;
  return (
    <>
      <p className="lede"><strong>{b.pass} of {plural(scored, "call")}</strong> passed.</p>
      <dl className="facts">
        <div><dt>Required outcomes met</dt><dd>{pct(b.state_pass_rate)}</dd></div>
        <div><dt>Calls with a false claim</dt><dd className={b.runs_with_false_claims ? "bad" : ""}>{b.runs_with_false_claims}</dd></div>
        <div><dt>Caller-handling checks passed</dt><dd>{pct(b.judged_pass_rate)}</dd></div>
        {b.invalid > 0 && <div><dt>Broken runs</dt><dd>{b.invalid}</dd></div>}
        {b.overridden > 0 && <div><dt>Verdicts set by a reviewer</dt><dd>{b.overridden}</dd></div>}
      </dl>
    </>
  );
}

export function Runs() {
  const batches = useFetch(() => api.batches(), []);
  const [batch, setBatch] = useQueryParam("batch");
  const [verdict, setVerdict] = useQueryParam("verdict");
  const runs = useFetch(() => api.runs({ ...(batch ? { batch } : {}), ...(verdict ? { verdict } : {}) }), [batch, verdict]);
  const current = batches.data?.find((b) => b.batch === batch) ?? null;

  return (
    <div className="page">
      <h1>Calls</h1>
      <p className="intro">Each row is one test call to the agent, graded automatically. The line in the middle shows the whole call; red marks are where something went wrong. Open a call to read it and see why it got its grade.</p>

      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Batch">
          <button role="tab" aria-selected={!batch} className={!batch ? "on" : ""} onClick={() => setBatch("")}>All batches</button>
          {batches.data?.map((b) => (
            <button key={b.batch} role="tab" aria-selected={batch === b.batch} className={batch === b.batch ? "on" : ""} onClick={() => setBatch(b.batch)}>
              {b.batch} <span className="count">{b.runs}</span>
            </button>
          ))}
        </div>
        <label className="select">Show
          <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
            <option value="">every call</option>
            <option value="fail">failed calls</option>
            <option value="pass">passed calls</option>
            <option value="invalid">broken runs</option>
            <option value="unevaluated">calls not scored yet</option>
          </select>
        </label>
      </div>

      {current && <Lede b={current} />}

      {!runs.data ? <Loading error={runs.error} /> : runs.data.length === 0 ? (
        <Empty title="No calls match this view.">
          {verdict ? <button className="link" onClick={() => setVerdict("")}>Show every call</button> : <>Record calls with <code>npx tsx src/cli/smoke-sim.ts A02 live</code>, then reload.</>}
        </Empty>
      ) : (
        <>
          <StripKey />
          <table className="runs">
            <thead><tr>
              <th>Scenario</th>
              <th className="col-strip">The call</th>
              <th>Result</th>
              <th className="num" title="Required outcomes met, from the system's records">Outcomes</th>
              <th className="num" title="Things the agent said were done that weren't">False claims</th>
              <th className="num" title="Caller-handling checks passed, judged by an LLM">Handling</th>
              <th>Your review</th>
            </tr></thead>
            <tbody>
              {runs.data.map((r) => {
                const href = `/runs/${encodeURIComponent(r.run_id)}`;
                return (
                  <tr key={r.run_id} onClick={() => navigate(href)}>
                    <td className="scenario-cell">
                      <Link to={href}><span className="sid">{r.scenario_id}</span> {r.title}</Link>
                      <div className="sub">{r.batch}, agent {r.agent_version} ({r.agent_model ?? "scripted"}){r.caller_type !== "simulated" ? `, ${r.caller_type} caller` : ""}</div>
                    </td>
                    <td className="col-strip"><CallStrip strip={r.strip} /></td>
                    <td><Verdict v={r.effective_verdict} overridden={r.overridden} />{r.run_status !== "completed" && r.run_status !== "turn_cap_hit" ? <div className="sub bad">{r.run_status.replace(/_/g, " ")}</div> : null}</td>
                    <td className="num">{r.state_total ? `${r.state_passed} of ${r.state_total}` : "–"}</td>
                    <td className={`num ${r.violations ? "bad strong" : ""}`}>{r.violations ?? "–"}</td>
                    <td className="num">{r.judged_applicable ? `${r.judged_passed} of ${r.judged_applicable}` : "–"}</td>
                    <td className="sub">{r.labels ? plural(r.labels, "label") : "Not reviewed"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
