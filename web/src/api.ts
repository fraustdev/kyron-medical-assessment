/** Typed fetch helpers. The response types come straight from the server's query functions. */
import type { batchStats, calibration, compare, getRun, listBatches, listRuns, overview, patterns, ReviewItem } from "../../src/server/api";

export type Batch = ReturnType<typeof batchStats>;
export type RunRow = ReturnType<typeof listRuns>[number];
export type RunDetail = NonNullable<ReturnType<typeof getRun>>;
export type Comparison = ReturnType<typeof compare>;
export type Patterns = ReturnType<typeof patterns>;
export type Calibration = ReturnType<typeof calibration>;
export type { ReviewItem };
export type Batches = ReturnType<typeof listBatches>;
export type Overview = ReturnType<typeof overview>;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, init);
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

export const api = {
  overview: () => req<Overview>("/overview"),
  batches: () => req<Batches>("/batches"),
  runs: (q: Record<string, string> = {}) => req<RunRow[]>(`/runs?${new URLSearchParams(q)}`),
  run: (id: string) => req<RunDetail>(`/runs/${encodeURIComponent(id)}`),
  label: (runId: string, itemId: string, human_passed: boolean | null, note: string) =>
    req<ReviewItem[]>(`/runs/${encodeURIComponent(runId)}/labels/${encodeURIComponent(itemId)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ human_passed, note }),
    }),
  compare: (a: string, b: string) => req<Comparison>(`/compare?${new URLSearchParams({ a, b })}`),
  patterns: (batch?: string) => req<Patterns>(`/patterns${batch ? `?batch=${encodeURIComponent(batch)}` : ""}`),
  calibration: () => req<Calibration>("/calibration"),
};
