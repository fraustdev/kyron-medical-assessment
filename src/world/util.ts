/** Small, deterministic parsing helpers shared by the mock tools. */

export function normName(s: string): string {
  return s.toLowerCase().replace(/^(dr|mr|mrs|ms)\.?\s+/, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n: number): string { return String(n).padStart(2, "0"); }
function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
function fullYear(y: number): number { return y < 100 ? (y > 30 ? 1900 + y : 2000 + y) : y; }

/**
 * Parse a date the way a phone agent might pass it: 1947-05-12, 05/12/1947, 3/14/95, "May 12, 1947",
 * "May 12th 1947", "12 May 1947". Returns YYYY-MM-DD or null.
 */
export function parseDate(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ");
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return iso(fullYear(+m[3]!), +m[1]!, +m[2]!);
  m = s.match(/^([a-z]+)\.? (\d{1,2}) (\d{2,4})$/);
  if (m) {
    const mon = monthNumber(m[1]!);
    return mon ? iso(fullYear(+m[3]!), mon, +m[2]!) : null;
  }
  m = s.match(/^(\d{1,2}) ([a-z]+)\.? (\d{2,4})$/);
  if (m) {
    const mon = monthNumber(m[2]!);
    return mon ? iso(fullYear(+m[3]!), mon, +m[1]!) : null;
  }
  return null;
}

function monthNumber(word: string): number | undefined {
  return MONTHS[word.slice(0, 3)];
}

/** Parse a date range: {start,end}, [start,end], "a..b", "a to b", or a single date (start = end). */
export function parseDateRange(input: unknown): { start: string; end: string } | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    const a = parseDate(o.start ?? o.from), b = parseDate(o.end ?? o.to);
    return a && b ? { start: a, end: b } : null;
  }
  if (Array.isArray(input) && input.length === 2) {
    const a = parseDate(input[0]), b = parseDate(input[1]);
    return a && b ? { start: a, end: b } : null;
  }
  if (typeof input === "string") {
    const parts = input.split(/\s*(?:\.\.|\bto\b|\/(?=\d{4}-))\s*/i);
    if (parts.length === 2) {
      const a = parseDate(parts[0]), b = parseDate(parts[1]);
      return a && b ? { start: a, end: b } : null;
    }
    const one = parseDate(input);
    return one ? { start: one, end: one } : null;
  }
  return null;
}

/** Harness-normalized reason tag (datasets say it is not graded by equality). */
export function reasonTag(reason: unknown): string {
  return String(reason ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "unspecified";
}

/** "2026-09-24T16:40:00 (Thursday, local time)" -> Date parts for deterministic ready times. */
export function simulatedDate(simulatedNow: string): string {
  return simulatedNow.slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
