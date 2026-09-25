import { api, type Comparison } from "../api";
import { Link, useQueryParam } from "../router";
import { Empty, Loading, pct, plural, useFetch, Verdict } from "../ui";

type Side = Comparison["rows"][number]["a"];
const ORDER: Record<string, number> = { regressed: 0, improved: 1, same: 2, missing: 3 };
const CHANGE_LABEL: Record<string, string> = { regressed: "Worse", improved: "Better", same: "No change", missing: "Not in both" };

function Summary({ c }: { c: Comparison }) {
  const better = c.rows.filter((r) => r.change === "improved").length;
  const worse = c.rows.filter((r) => r.change === "regressed").length;
  const aScored = c.a.evaluated - c.a.invalid, bScored = c.b.evaluated - c.b.invalid;
  const unscored = [c.a, c.b].filter((x) => x.evaluated - x.invalid === 0).map((x) => x.batch);
  if (unscored.length) return <p className="lede"><strong>{unscored.join(" and ")}</strong> {unscored.length > 1 ? "have" : "has"} no scored calls yet, so there is nothing to compare. Score a batch with <code>src/cli/evaluate.ts</code> first.</p>;
  return (
    <p className="lede">
      <strong>{c.b.batch}</strong> passed {c.b.pass} of {plural(bScored, "call")}, against {c.a.pass} of {aScored} for <strong>{c.a.batch}</strong>.
      {" "}{better || worse ? `${plural(better, "scenario")} got better and ${worse} got worse.` : "No scenario changed its result."}
    </p>
  );
}

export function Compare() {
  const batches = useFetch(() => api.batches(), []);
  const [a, setA] = useQueryParam("a");
  const [b, setB] = useQueryParam("b");
  const [only, setOnly] = useQueryParam("changed");
  const cmp = useFetch(() => (a && b ? api.compare(a, b) : Promise.resolve(null)), [a, b]);

  const pick = (value: string, set: (v: string) => void, label: string) => (
    <label className="select">{label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">choose a batch</option>
        {batches.data?.map((x) => <option key={x.batch} value={x.batch}>{x.batch}: {x.agents.join(", ")}</option>)}
      </select>
    </label>
  );

  const metric = (label: string, x: number | null, y: number | null, kind: "rate" | "count", higherIsBetter = true) => {
    const d = x !== null && y !== null ? y - x : null;
    const tone = d === null || d === 0 ? "" : (d > 0) === higherIsBetter ? "good" : "bad";
    const fmt = (v: number | null) => (kind === "rate" ? pct(v) : String(v ?? "–"));
    const delta = d === null || d === 0 ? "same" : kind === "rate" ? `${d > 0 ? "+" : "−"}${Math.abs(Math.round(d * 100))} points` : `${d > 0 ? "+" : "−"}${Math.abs(d)}`;
    return <tr><th scope="row">{label}</th><td className="num">{fmt(x)}</td><td className="num">{fmt(y)}</td><td className={`num ${tone}`}>{delta}</td></tr>;
  };

  return (
    <div className="page">
      <h1>Compare versions</h1>
      <p className="intro">Run the same scenarios against two agent versions (or prompts, or models), then see what changed, scenario by scenario.</p>
      <div className="toolbar">{pick(a, setA, "Before")}{pick(b, setB, "After")}</div>

      {!a || !b ? <Empty title="Choose a batch for “Before” and one for “After”.">Each batch is one run of the scenarios, stored under <code>runs/&lt;batch&gt;/</code>.</Empty>
        : !cmp.data ? <Loading error={cmp.error} /> : (
        <>
          <Summary c={cmp.data} />
          <table className="plain metrics">
            <thead><tr><th /><th className="num">Before</th><th className="num">After</th><th className="num">Change</th></tr></thead>
            <tbody>
              {metric("Calls passed", cmp.data.a.pass_rate, cmp.data.b.pass_rate, "rate")}
              {metric("Required outcomes met", cmp.data.a.state_pass_rate, cmp.data.b.state_pass_rate, "rate")}
              {metric("Caller-handling checks passed", cmp.data.a.judged_pass_rate, cmp.data.b.judged_pass_rate, "rate")}
              {metric("Calls with a false claim", cmp.data.a.runs_with_false_claims, cmp.data.b.runs_with_false_claims, "count", false)}
              {metric("False claims in total", cmp.data.a.false_claims, cmp.data.b.false_claims, "count", false)}
            </tbody>
          </table>

          <div className="section-head">
            <h2>Scenario by scenario</h2>
            <label className="check"><input type="checkbox" checked={only === "1"} onChange={(e) => setOnly(e.target.checked ? "1" : "")} /> Only scenarios that changed</label>
          </div>
          <table className="runs">
            <thead><tr><th>Scenario</th><th>Before</th><th>After</th><th>Change</th><th className="num">Outcomes met</th><th className="num">False claims</th></tr></thead>
            <tbody>
              {[...cmp.data.rows].sort((x, y) => ORDER[x.change]! - ORDER[y.change]!)
                .filter((r) => only !== "1" || r.change === "improved" || r.change === "regressed").map((r) => (
                <tr key={r.scenario_id} className="static">
                  <td className="scenario-cell"><span className="sid">{r.scenario_id}</span> {r.title}</td>
                  <td><RunsCell side={r.a} /></td>
                  <td><RunsCell side={r.b} /></td>
                  <td><span className={`change ${r.change}`}>{CHANGE_LABEL[r.change]}</span></td>
                  <td className="num">{pct(r.a?.state_pass_rate)} to {pct(r.b?.state_pass_rate)}</td>
                  <td className="num">{r.a?.false_claims ?? "–"} to {r.b?.false_claims ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function RunsCell({ side }: { side: Side }) {
  if (!side) return <span className="sub">no call</span>;
  return <span className="runs-inline">{side.runs.map((r) => <Link key={r.run_id} to={`/runs/${encodeURIComponent(r.run_id)}`}><Verdict v={r.verdict} /></Link>)}</span>;
}
