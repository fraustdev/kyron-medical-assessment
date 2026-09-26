import { Link, useLocation } from "./router";
import { Calibration } from "./pages/Calibration";
import { Compare } from "./pages/Compare";
import { Patterns } from "./pages/Patterns";
import { RunDetail } from "./pages/RunDetail";
import { Runs } from "./pages/Runs";

const NAV = [
  { to: "/", label: "Calls", match: (p: string) => p === "/" || p.startsWith("/calls") || p.startsWith("/runs") },
  { to: "/compare", label: "Compare versions", match: (p: string) => p.startsWith("/compare") },
  { to: "/patterns", label: "Recurring failures", match: (p: string) => p.startsWith("/patterns") },
  { to: "/calibration", label: "Review & calibration", match: (p: string) => p.startsWith("/calibration") },
];

export function App() {
  const url = useLocation();
  const path = url.pathname;
  const run = /^\/runs\/(.+)$/.exec(path);
  return (
    <div className="shell">
      <header className="top">
        <Link to="/" className="brand">
          <svg className="brand-mark" viewBox="0 0 28 28" aria-hidden>
            <path d="M2 16h5l3-8 4 13 3-9 2 4h7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Harbor Eval
        </Link>
        <nav aria-label="Main">
          {NAV.map((n) => <Link key={n.to} to={n.to} className={n.match(path) ? "active" : ""}>{n.label}</Link>)}
        </nav>
      </header>
      <main>
        {run ? <RunDetail runId={decodeURIComponent(run[1]!)} />
          : path.startsWith("/compare") ? <Compare />
          : path.startsWith("/patterns") ? <Patterns />
          : path.startsWith("/calibration") ? <Calibration />
          : <Runs />}
      </main>
    </div>
  );
}
