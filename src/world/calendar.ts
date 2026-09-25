/**
 * TypeScript port of scripts/calendar_lib.py (the clinic slot calendar, decision D4).
 * slot_id = {PROVIDER_ID}-{YYYYMMDD}-{HHMM}; a visit occupies ceil(minutes / slot_minutes) consecutive slots
 * on the same provider-day and may not run past day_end.
 */
import type { CalendarSpec } from "./dataset.js";

const SLOT_RE = /^([A-Z]{3})-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/;

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}
function hhmm(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}${String(total % 60).padStart(2, "0")}`;
}

export function calendarDays(cal: CalendarSpec): string[] {
  const out: string[] = [];
  const d = new Date(`${cal.date_range[0]}T12:00:00Z`);
  const end = new Date(`${cal.date_range[1]}T12:00:00Z`);
  while (d <= end) {
    const dow = d.getUTCDay();
    if (!cal.weekdays_only || (dow >= 1 && dow <= 5)) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function dayTimes(cal: CalendarSpec): string[] {
  const out: string[] = [];
  for (let t = minutes(cal.day_start); t + cal.slot_minutes <= minutes(cal.day_end); t += cal.slot_minutes) out.push(hhmm(t));
  return out;
}

export interface ParsedSlot { provider: string; date: string; hhmm: string }

export function parseSlot(slotId: string): ParsedSlot | null {
  const m = SLOT_RE.exec(slotId);
  if (!m) return null;
  return { provider: m[1]!, date: `${m[2]}-${m[3]}-${m[4]}`, hhmm: `${m[5]}${m[6]}` };
}

export function isValidSlot(cal: CalendarSpec, providerIds: Iterable<string>, slotId: string): boolean {
  const p = parseSlot(slotId);
  if (!p || ![...providerIds].includes(p.provider)) return false;
  return calendarDays(cal).includes(p.date) && dayTimes(cal).includes(p.hhmm);
}

/** Slot ids a visit starting at slotId occupies, or null if it would run past the end of the day. */
export function occupiedSlots(cal: CalendarSpec, slotId: string, durationMin: number): string[] | null {
  const p = parseSlot(slotId);
  if (!p) return null;
  const times = dayTimes(cal);
  const i = times.indexOf(p.hhmm);
  const n = Math.ceil(durationMin / cal.slot_minutes);
  if (i < 0 || i + n > times.length) return null;
  const ymd = p.date.replace(/-/g, "");
  return times.slice(i, i + n).map((t) => `${p.provider}-${ymd}-${t}`);
}

export function slotStartIso(slotId: string): string {
  const p = parseSlot(slotId)!;
  return `${p.date}T${p.hhmm.slice(0, 2)}:${p.hhmm.slice(2)}`;
}

export function allSlots(cal: CalendarSpec, providerIds: string[]): string[] {
  const days = calendarDays(cal), times = dayTimes(cal);
  return providerIds.flatMap((p) => days.flatMap((d) => times.map((t) => `${p}-${d.replace(/-/g, "")}-${t}`)));
}
