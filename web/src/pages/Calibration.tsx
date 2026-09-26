import { api, type Calibration as Cal } from "../api";
import { Link } from "../router";
import { Empty, Loading, pct, plural, useFetch } from "../ui";

const SOURCE: Record<string, string> = {
  judged: "Caller handling, judged by an LLM",
  claim: "Claims: found by an LLM, checked against records",
  state: "Required outcomes, checked by code",
  run: "Overall verdict",
};

export function Calibration() {
  const c = useFetch(() => api.calibration(), []);
  const runs = useFetch(() => api.runs(), []);
  if (!c.data) return <Loading error={c.error} />;
  const d = c.data;
  const waiting = (runs.data ?? []).filter((r) => r.verdict !== null && r.verdict !== "invalid" && r.labels === 0);
  const sources = (Object.entries(d.bySource) as [string, Cal["overall"]][]).filter(([, s]) => s.n > 0);

  const queue = (
    <>
      <h2>Calls waiting for your review</h2>
      {waiting.length === 0 ? <p className="sub">Every scored call has at least one label.</p> : (
        <div className="pills">{waiting.map((r) => <Link key={r.run_id} to={`/runs/${encodeURIComponent(r.run_id)}`} className="pill">{r.scenario_id} in {r.batch}</Link>)}</div>
      )}
    </>
  );

  return (
    <div className="page">
      <h1>Review &amp; calibration</h1>
      <p className="intro">An automated evaluator is only worth trusting if it agrees with a careful human. Open a call, mark its findings Pass or Fail, and this page measures how often the evaluator got it right.</p>

      {d.overall.n === 0 ? (
        <>
          <Empty title="You haven't reviewed any findings yet.">Pick a call below. On its page, use the Pass and Fail buttons next to each finding.</Empty>
          {queue}
        </>
      ) : (
        <>
          <p className="lede">The evaluator agreed with you on <strong>{d.overall.agree} of {plural(d.overall.n, "finding")}</strong> ({pct(d.overall.agreement)}) across {plural(d.labeled_runs, "call")}.</p>
          <dl className="facts">
            <div><dt>Agreement beyond chance (Cohen's κ)</dt><dd>{d.overall.kappa === null ? "–" : d.overall.kappa.toFixed(2)}</dd></div>
            <div><dt>Passed something you failed</dt><dd className={d.overall.evaluator_too_lenient ? "bad" : ""}>{d.overall.evaluator_too_lenient}</dd></div>
            <div><dt>Failed something you passed</dt><dd className={d.overall.evaluator_too_strict ? "bad" : ""}>{d.overall.evaluator_too_strict}</dd></div>
          </dl>

          <h2>By part of the evaluator</h2>
          <table className="plain metrics">
            <thead><tr><th /><th className="num">Reviewed</th><th className="num">Agreed</th><th className="num">κ</th><th className="num">Too lenient</th><th className="num">Too strict</th></tr></thead>
            <tbody>
              {sources.map(([k, s]) => (
                <tr key={k}><th scope="row">{SOURCE[k] ?? k}</th><td className="num">{s.n}</td><td className="num">{pct(s.agreement)}</td><td className="num">{s.kappa === null ? "–" : s.kappa.toFixed(2)}</td><td className="num">{s.evaluator_too_lenient}</td><td className="num">{s.evaluator_too_strict}</td></tr>
              ))}
            </tbody>
          </table>

          <h2>Where you and the evaluator disagree</h2>
          {d.disagreements.length === 0 ? <p className="sub">Nowhere yet: the evaluator matched every finding you reviewed.</p> : (
            <table className="runs disagreements">
              <colgroup><col className="c-call" /><col className="c-finding" /><col className="c-verdict" /><col className="c-verdict" /><col /></colgroup>
              <thead><tr><th>Call</th><th>Finding</th><th>Evaluator</th><th>You</th><th>Your note</th></tr></thead>
              <tbody>{d.disagreements.map((x) => (
                <tr key={x.run_id + x.item_id} className="static">
                  <td><Link to={`/runs/${encodeURIComponent(x.run_id)}`}><span className="sid">{x.scenario_id}</span></Link></td>
                  <td>{x.text}<div className="sub">{SOURCE[x.source]}</div></td>
                  <td className={x.auto_passed ? "good" : "bad"}>{x.auto_passed ? "Passed" : "Failed"}</td>
                  <td className={x.human_passed ? "good" : "bad"}>{x.human_passed ? "Passed" : "Failed"}</td>
                  <td className="sub">{x.note || "–"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {queue}
        </>
      )}
    </div>
  );
}
