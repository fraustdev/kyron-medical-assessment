"""Deterministic clinic slot calendar shared by the scheduling generator and the validator.

The calendar is ground truth for availability (decision D4). A slot is a 20-minute start time for one provider on
one weekday between day_start and day_end. slot_id format: {PROVIDER_CODE}-{YYYYMMDD}-{HHMM}, e.g. PAT-20261001-1400.
A visit occupies ceil(duration / slot_minutes) consecutive slots from its start slot, all on the same provider-day.
There is no randomness, so no seed is needed.
"""
from datetime import date, datetime, timedelta
import math
import re

SLOT_RE = re.compile(r"^([A-Z]{3})-(\d{8})-(\d{4})$")


def _t(hhmm):
    return datetime.strptime(hhmm, "%H:%M")


def calendar_days(cal):
    d = date.fromisoformat(cal["date_range"][0])
    end = date.fromisoformat(cal["date_range"][1])
    while d <= end:
        if not cal.get("weekdays_only", True) or d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def day_times(cal):
    t, end, step = _t(cal["day_start"]), _t(cal["day_end"]), timedelta(minutes=cal["slot_minutes"])
    while t + step <= end:
        yield t.strftime("%H%M")
        t += step


def all_slots(cal, provider_codes):
    """Every slot_id in the calendar, in chronological order per provider."""
    return {code: [f"{code}-{d:%Y%m%d}-{hm}" for d in calendar_days(cal) for hm in day_times(cal)] for code in provider_codes}


def parse_slot(slot_id):
    m = SLOT_RE.match(slot_id)
    if not m:
        return None
    code, ymd, hm = m.groups()
    return code, date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:])), hm


def is_valid_slot(cal, provider_codes, slot_id):
    p = parse_slot(slot_id)
    if not p or p[0] not in provider_codes:
        return False
    code, d, hm = p
    return d in set(calendar_days(cal)) and hm in set(day_times(cal))


def occupied_slots(cal, slot_id, duration_min):
    """Consecutive slot_ids a visit starting at slot_id occupies, or None if it would run past the end of the day."""
    code, d, hm = parse_slot(slot_id)
    times = list(day_times(cal))
    i = times.index(hm)
    n = math.ceil(duration_min / cal["slot_minutes"])
    if i + n > len(times):
        return None
    return [f"{code}-{d:%Y%m%d}-{t}" for t in times[i:i + n]]


def slot_start_iso(slot_id):
    code, d, hm = parse_slot(slot_id)
    return f"{d.isoformat()}T{hm[:2]}:{hm[2:]}"


def slot_label(slot_id):
    code, d, hm = parse_slot(slot_id)
    t = datetime.strptime(hm, "%H%M")
    return f"{d:%a %b} {d.day}, {t:%I:%M %p}".replace(" 0", " ")
