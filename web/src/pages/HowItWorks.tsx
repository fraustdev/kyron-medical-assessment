import { api } from "../api";
import { Link } from "../router";
import { useFetch } from "../ui";

const STEPS = [
  { title: "A test scenario", body: "A realistic call, such as a refill, a transfer or a reschedule, plus an answer key for what a correct agent does. Written from real pharmacy practice." },
  { title: "A simulated caller", body: "An AI actor plays the patient. It improvises in character and says a few scripted lines at key moments, but only if the agent gets that far." },
  { title: "The live call", body: "The agent being tested answers in real time. It uses mock pharmacy and clinic systems to look up and change records." },
  { title: "The recording", body: "Every word, every system action and every record change is saved, so the call can be replayed exactly." },
  { title: "Automatic grading", body: "Code checks the records against the answer key. An AI judge reads the conversation. Every result points to the moment in the call it's about." },
  { title: "Human review", body: "An expert marks each result right or wrong. The lab measures how often the automatic grader agrees, so you know how far to trust it." },
];

export function HowItWorks() {
  const o = useFetch(() => api.overview(), []);
  const d = o.data;
  return (
    <div className="page start">
      <h1>A test lab for an AI pharmacy phone agent</h1>
      <p className="lede">
        AI agents are starting to answer pharmacy and clinic phone lines. Before one talks to real patients, and every time it changes,
        someone has to check that it does the job and stays safe. This lab runs the agent through realistic test calls,
        records everything and grades each call. It also shows exactly <em>why</em> each call got its grade, so a person can check the grader.
      </p>

      <h2>How a test call works</h2>
      <ol className="flow">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="flow-n" aria-hidden>{i + 1}</span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="two-col">
        <section>
          <h2>What's live and what's fixed</h2>
          <p><strong>Live:</strong> everything the agent says and does, and most of what the caller says. Nobody scripts the agent, so its mistakes are real.</p>
          <p><strong>Fixed:</strong> the situation (who calls, what's on file), a few scripted moments, and the answer key. Like a crash test: the crash is real, but the conditions are controlled. That makes two versions of the agent comparable on the same test.</p>
          <p className="sub">Calls are typed text, not voice. Speech-recognition errors and callers talking over the agent are out of scope.</p>
        </section>
        <section>
          <h2>What's in the lab now</h2>
          {d ? (
            <ul className="inventory">
              <li><strong>{d.scenarios} test scenarios</strong>: {Object.entries(d.datasets).map(([k, v]) => `${v.scenarios} ${k === "pharmacy" ? "pharmacy calls (refills, renewals, transfers)" : "clinic calls (booking, rescheduling)"}`).join(" and ")}.</li>
              <li><strong>{d.runs} recorded {d.runs === 1 ? "call" : "calls"}</strong> in {d.batches} {d.batches === 1 ? "batch" : "batches"}, {d.scored} scored.</li>
              {d.models && <li>Agent being tested: <strong>{d.models.agent}</strong>. Caller played by <strong>{d.models.caller}</strong>. Conversation judged by <strong>{d.models.judge ?? "not yet"}</strong>.</li>}
            </ul>
          ) : <p className="sub">Loading…</p>}
          {d?.example && <p><Link to={`/runs/${encodeURIComponent(d.example.run_id)}`} className="button">See a graded call: {d.example.title}</Link></p>}
        </section>
      </div>

    </div>
  );
}
