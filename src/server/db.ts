/**
 * The app's database (SQLite, Node's built-in driver). It is DERIVED: rebuilt from the committed run files
 * (runs/<batch>/*.json + *.eval.json) on start, so a fresh clone needs no setup. The one thing people create in
 * the app, human labels, is also written to labels/labels.json (committed), so reviews survive a rebuild.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvalResult } from "../eval/evaluate.js";
import type { Trace } from "../trace/types.js";
import { loadDataset, REPO_ROOT, type Scenario } from "../world/dataset.js";

export const RUNS_DIR = join(REPO_ROOT, "runs");
export const LABELS_FILE = join(REPO_ROOT, "labels", "labels.json");
/** The on-disk database (gitignored). It is derived: delete it any time and it is rebuilt from runs/ and labels/. */
export const DB_FILE = join(REPO_ROOT, "data", "harbor.db");

/** An in-memory copy for read-only command-line use (never touches data/harbor.db, which the app may hold open). */
export function inMemoryDb(): Db {
  const db = new Db();
  db.importRuns();
  db.importLabels();
  return db;
}

/** Open a fresh database file rebuilt from the committed runs and labels. */
export function openFreshDb(file = DB_FILE): Db {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) rmSync(file);
  const db = new Db(file);
  db.importRuns();
  db.importLabels();
  return db;
}

export interface Label { run_id: string; item_id: string; human_passed: boolean; note: string; updated_at: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, batch TEXT NOT NULL, scenario_id TEXT NOT NULL, dataset TEXT NOT NULL,
  title TEXT, category TEXT, tags TEXT,
  agent_id TEXT, agent_version TEXT, agent_model TEXT, caller_type TEXT, caller_model TEXT,
  run_status TEXT, mode TEXT, trial_index INTEGER, started_at TEXT,
  turns INTEGER, tool_calls INTEGER,
  verdict TEXT, state_passed INTEGER, state_total INTEGER, violations INTEGER,
  judged_passed INTEGER, judged_applicable INTEGER,
  trace_path TEXT NOT NULL, trace_json TEXT NOT NULL, eval_json TEXT
);
CREATE INDEX IF NOT EXISTS runs_batch ON runs(batch);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER NOT NULL, t_ms INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS final_states (
  run_id TEXT PRIMARY KEY, end_state TEXT NOT NULL, counts TEXT NOT NULL, validity TEXT
);
CREATE TABLE IF NOT EXISTS labels (
  run_id TEXT NOT NULL, item_id TEXT NOT NULL, human_passed INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, PRIMARY KEY (run_id, item_id)
);`;

export class Db {
  readonly db: DatabaseSync;
  private readonly scenarios = new Map<string, Scenario & { _dataset: string }>();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    for (const key of ["pharmacy", "scheduling"] as const) {
      for (const s of loadDataset(key).data.scenarios) this.scenarios.set(s.id, { ...s, _dataset: key });
    }
  }

  scenario(id: string) { return this.scenarios.get(id) ?? null; }

  /** A batch's one-line description, from runs/<batch>/batch.json (optional). */
  batchDescription(batch: string, dir = RUNS_DIR): string | null {
    const f = join(dir, batch, "batch.json");
    if (!existsSync(f)) return null;
    try { return String((JSON.parse(readFileSync(f, "utf8")) as { description?: unknown }).description ?? "") || null; } catch { return null; }
  }

  /** Load every trace under runs/ (and its .eval.json, if any). Returns the number of runs loaded. */
  importRuns(dir = RUNS_DIR): number {
    let n = 0;
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : f.endsWith(".json") && !f.endsWith(".eval.json") ? [p] : [];
    });
    if (!existsSync(dir)) return 0;
    const insert = this.db.prepare(`INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insEvent = this.db.prepare(`INSERT OR REPLACE INTO events VALUES (?,?,?,?,?,?)`);
    const insFinal = this.db.prepare(`INSERT OR REPLACE INTO final_states VALUES (?,?,?,?)`);
    for (const file of walk(dir)) {
      let trace: Trace;
      try { trace = JSON.parse(readFileSync(file, "utf8")) as Trace; } catch { continue; }
      if (!trace?.metadata?.run_id || !Array.isArray(trace.events)) continue;
      const evalFile = file.replace(/\.json$/, ".eval.json");
      const ev = existsSync(evalFile) ? (JSON.parse(readFileSync(evalFile, "utf8")) as EvalResult) : null;
      const m = trace.metadata;
      const sc = this.scenarios.get(m.scenario_id);
      const batch = relative(dir, dirname(file)).replace(/\\/g, "/") || "(root)";
      insert.run(
        m.run_id, batch, m.scenario_id, sc?._dataset ?? m.dataset.name,
        sc?.title ?? null, (sc as { category?: string } | undefined)?.category ?? null, JSON.stringify((sc as { hard_case_tags?: string[] } | undefined)?.hard_case_tags ?? []),
        m.agent.id, m.agent.version, m.agent.model, m.caller.type, m.caller.model,
        m.run_status, m.mode, m.trial_index, m.started_at,
        trace.final.counts.turns, trace.final.counts.tool_calls,
        ev?.summary.verdict ?? null, ev?.summary.state_passed ?? null, ev?.summary.state_total ?? null, ev?.summary.violations ?? null,
        ev?.summary.judged_passed ?? null, ev?.summary.judged_applicable ?? null,
        relative(REPO_ROOT, file).replace(/\\/g, "/"), JSON.stringify(trace), ev ? JSON.stringify(ev) : null,
      );
      for (const e of trace.events) insEvent.run(m.run_id, e.seq, e.turn, Math.round(e.t_ms), e.type, JSON.stringify(e));
      insFinal.run(m.run_id, JSON.stringify(trace.final.end_state), JSON.stringify(trace.final.counts), trace.validity ? JSON.stringify(trace.validity) : null);
      n += 1;
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------ labels

  importLabels(file = LABELS_FILE): number {
    if (!existsSync(file)) return 0;
    const labels = JSON.parse(readFileSync(file, "utf8")) as Label[];
    const ins = this.db.prepare(`INSERT OR REPLACE INTO labels VALUES (?,?,?,?,?)`);
    for (const l of labels) ins.run(l.run_id, l.item_id, l.human_passed ? 1 : 0, l.note ?? "", l.updated_at);
    return labels.length;
  }

  labels(runId?: string): Label[] {
    const rows = (runId
      ? this.db.prepare(`SELECT * FROM labels WHERE run_id = ? ORDER BY item_id`).all(runId)
      : this.db.prepare(`SELECT * FROM labels ORDER BY run_id, item_id`).all()) as unknown as (Omit<Label, "human_passed"> & { human_passed: number })[];
    return rows.map((r) => ({ ...r, human_passed: r.human_passed === 1 }));
  }

  setLabel(runId: string, itemId: string, humanPassed: boolean | null, note: string, file = LABELS_FILE): void {
    if (humanPassed === null) this.db.prepare(`DELETE FROM labels WHERE run_id = ? AND item_id = ?`).run(runId, itemId);
    else this.db.prepare(`INSERT OR REPLACE INTO labels VALUES (?,?,?,?,?)`).run(runId, itemId, humanPassed ? 1 : 0, note, new Date().toISOString());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.labels(), null, 2) + "\n");
  }
}
