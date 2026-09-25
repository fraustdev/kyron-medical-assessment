import { api, type Patterns as P } from "../api";
import { Link, useQueryParam } from "../router";
import { Bar, Empty, Loading, pct, plural, useFetch } from "../ui";

const FAILURE_TYPE: Record<string, string> = {
  carelessness: "Careless: did something wrong or skipped a required step",
  over_caution: "Over-cautious: refused, stalled or escalated when it should have helped",
  unspecified: "Not classified",
};
const SOURCE: Record<string, string> = {
  state: "Required outcomes (records)",
  claim: "False claims",
  judged: "Caller handling (LLM judge)",
};

function Counts({ title, data, labels }: { title: string; data: Record<string, number>; labels?: Record<string, string> }) {
  const max = Math.max(0, ...Object.values(data));
  const entries = Object.entries(data).sort((x, y) => y[1] - x[1]);
  return (
    <section className="tally">
      <h3>{title}</h3>
      {entries.length === 0 ? <p className="sub">None.</p> : entries.map(([k, v]) => (
        <div key={k} className="bar-row"><span>{labels?.[k] ?? k.replace(/_/g, " ")}</span><Bar value={v} max={max} tone="fail" /><span className="num">{v}</span></div>
      ))}
    </section>
  );
}

function Rates({ title, data }: { title: string; data: Record<string, { runs: number; pass: number }> }) {
  const entries = Object.entries(data).sort((x, y) => x[1].pass / x[1].runs - y[1].pass / y[1].runs);
  return (
    <section className="tally">
      <h3>{title}</h3>
      {entries.length === 0 ? <p className="sub">None.</p> : entries.map(([k, v]) => (
        <div key={k} className="bar-row"><span>{k.replace(/_/g, " ")}</span><Bar value={v.pass} max={v.runs} tone="pass" /><span className="num">{pct(v.pass / v.runs)} of {v.runs}</span></div>
      ))}
    </section>
  );
}

export function Patterns() {
  const batches = useFetch(() => api.batches(), []);
  const [batch, setBatch] = useQueryParam("batch");
  const p = useFetch(() => api.patterns(batch || undefined), [batch]);

  // The same failed check recurring across calls is the pattern: group by where it was caught + its text.
  const grouped = new Map<string, P["failedItems"]>();
  for (const f of p.data?.failedItems ?? []) {
    const k = `${f.source}|${f.text}`;
    grouped.set(k, [...(grouped.get(k) ?? []), f]);
  }
  const ranked = [...grouped.values()].sort((x, y) => y.length - x.length);
  const top = ranked[0];

  return (
    <div className="page">
      <h1>Recurring failures</h1>
      <p className="intro">Failures that repeat across calls point at a real weakness in the agent, not a one-off. Your review labels take precedence over the evaluator here.</p>
      <div className="toolbar">
        <label className="select">Batch
          <select value={batch} onChange={(e) => setBatch(e.target.value)}>
            <option value="">all batches</option>
            {batches.data?.map((b) => <option key={b.batch} value={b.batch}>{b.batch}</option>)}
          </select>
        </label>
      </div>

      {!p.data ? <Loading error={p.error} /> : p.data.runs === 0 ? <Empty title="No scored calls yet.">Score a batch with <code>npx tsx src/cli/evaluate.ts runs/&lt;batch&gt;/*.json</code>.</Empty> : (
        <>
          <p className="lede">
            {!top ? <>No failures across {plural(p.data.runs, "scored call")}.</>
              : top.length > 1 ? <>Across {plural(p.data.runs, "scored call")}, the most frequent failure is <strong>“{top[0]!.text}”</strong>, in {plural(top.length, "call")}.</>
              : <>Across {plural(p.data.runs, "scored call")}, <strong>{plural(p.data.failedItems.length, "check")} failed</strong>, but none has failed in more than one call yet.</>}
          </p>
          <div className="tallies">
            <Counts title="Kind of mistake" data={p.data.byFailureType} labels={FAILURE_TYPE} />
            <Counts title="Where the failures were caught" data={p.data.bySource} labels={SOURCE} />
            <Counts title="False claims, by type" data={p.data.byViolation} />
          </div>
          <div className="tallies two">
            <Rates title="Pass rate by kind of scenario" data={p.data.byCategory} />
            <Rates title="Pass rate by difficulty" data={p.data.byTag} />
          </div>

          <h2>Every failed check</h2>
          <table className="runs">
            <thead><tr><th>Check</th><th>Caught by</th><th>Kind of mistake</th><th>Calls</th></tr></thead>
            <tbody>
              {ranked.map((fs) => (
                <tr key={`${fs[0]!.source}|${fs[0]!.text}`} className="static">
                  <td>{fs[0]!.text}</td>
                  <td className="sub">{SOURCE[fs[0]!.source] ?? fs[0]!.source}</td>
                  <td className="sub">{fs[0]!.failure_type ? (FAILURE_TYPE[fs[0]!.failure_type] ?? fs[0]!.failure_type).split(":")[0] : "–"}</td>
                  <td>{fs.map((f) => <Link key={f.run_id + f.item_id} to={`/runs/${encodeURIComponent(f.run_id)}`} className="pill">{f.scenario_id}</Link>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
