/** Small text helpers shared by the simulated caller and the run-validity checks. */

const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w.length > 1));

/** Share of `ref`'s words that appear in `text` (1 = every word of ref is present). */
export function overlap(ref: string, text: string): number {
  const a = words(ref), b = words(text);
  if (a.size === 0) return 1;
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n / a.size;
}
