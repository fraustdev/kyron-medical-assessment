/**
 * The web app's server: a JSON API over the run database, plus the built frontend (web/dist).
 *
 *   npm run app            build the frontend, then serve on http://localhost:5174
 *   npm run web:dev        (second terminal) Vite dev server with hot reload, proxying /api here
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { REPO_ROOT } from "../world/dataset.js";
import { batchStats, calibration, compare, getRun, listBatches, listRuns, patterns } from "./api.js";
import { openFreshDb, type Db } from "./db.js";

const PORT = Number(process.env.PORT ?? 5174);
const DIST = join(REPO_ROOT, "web", "dist");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

let db = load();
function load(previous?: Db): Db {
  // Windows keeps an open database file locked: close the old connection before rebuilding the file.
  try { previous?.db.close(); } catch { /* already closed */ }
  const d = openFreshDb();
  const runs = (d.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  console.log(`loaded ${runs} runs and ${d.labels().length} labels`);
  return d;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const p = url.pathname.replace(/^\/api/, "");
  const q = Object.fromEntries(url.searchParams);
  let m: RegExpExecArray | null;

  if (req.method === "GET" && p === "/batches") return json(res, 200, listBatches(db));
  if (req.method === "GET" && (m = /^\/batches\/(.+)$/.exec(p))) return json(res, 200, batchStats(db, decodeURIComponent(m[1]!)));
  if (req.method === "GET" && p === "/runs") return json(res, 200, listRuns(db, q));
  if (req.method === "GET" && (m = /^\/runs\/([^/]+)$/.exec(p))) {
    const r = getRun(db, decodeURIComponent(m[1]!));
    return r ? json(res, 200, r) : json(res, 404, { error: "no such run" });
  }
  if (req.method === "PUT" && (m = /^\/runs\/([^/]+)\/labels\/([^/]+)$/.exec(p))) {
    const runId = decodeURIComponent(m[1]!), itemId = decodeURIComponent(m[2]!);
    if (!getRun(db, runId)) return json(res, 404, { error: "no such run" });
    const body = (await readBody(req)) as { human_passed?: boolean | null; note?: string };
    if (body.human_passed !== null && typeof body.human_passed !== "boolean") return json(res, 400, { error: "human_passed must be true, false or null" });
    db.setLabel(runId, itemId, body.human_passed ?? null, String(body.note ?? ""));
    return json(res, 200, getRun(db, runId)!.review);
  }
  if (req.method === "GET" && p === "/compare") {
    if (!q.a || !q.b) return json(res, 400, { error: "a and b (batch names) are required" });
    return json(res, 200, compare(db, q.a, q.b));
  }
  if (req.method === "GET" && p === "/patterns") return json(res, 200, patterns(db, q.batch || undefined));
  if (req.method === "GET" && p === "/calibration") return json(res, 200, calibration(db));
  if (req.method === "POST" && p === "/reload") { db = load(db); return json(res, 200, { ok: true }); }
  return json(res, 404, { error: "not found" });
}

function serveStatic(res: ServerResponse, url: URL): void {
  if (!existsSync(DIST)) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Frontend not built. Run `npm run app` (or `npm run web:build`).");
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  let file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // SPA routes
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch((e: unknown) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  } else serveStatic(res, url);
}).listen(PORT, () => console.log(`eval app on http://localhost:${PORT}`));
