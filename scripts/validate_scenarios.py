"""Validate a Harbor scenario dataset: pharmacy (pharmacy_call_scenarios.v2.json) or clinic scheduling
(scheduling_call_scenarios.v1.json). The dataset is detected from its `dataset` field.

Checks
  1. JSON Schema validity (scenario.schema.json, draft 2020-12).
  2. Referential integrity.
     Pharmacy: every rx_id / store_id used anywhere exists in the scenario's fixture.
     Scheduling: every slot_id is a real calendar slot for a provider in the fixture; every appointment_id
     exists in the fixture (or is APT-NEW-<valid slot>); providers, patients and visit types resolve.
  3. Declared vocabulary: every tool and state collection used by checks, claims, faults and end states
     is declared in agent_context.tools / state_model; end states list exactly the declared collections.
  4. Calendar (scheduling): no slot is double-booked in any starting fixture, every fixture appointment
     fits its visit length inside the day, and every expected or acceptable booking fits entirely in open slots.
  5. Every policy_ref exists; the urgency-tier policy and escalation block match urgency_tier.
  6. Every v1 must_do / must_not_do item is mapped exactly once (pharmacy only).
  7. v1 persona fields change only with a recorded reason (pharmacy only).
  8. Fault variants differ from their parent ONLY in tool_faults + grading; declared twins differ from
     their twin ONLY in the fields they declare (twin_varies), and every declared field really differs.
  9. Cross-dataset links (related_scenarios, external_records) resolve in the related dataset, and the
     shared caller_sim_instructions are identical across datasets.
 10. Self-consistency: pure state checks pass on expected_end_state (and on non-conditional acceptable
     outcomes); no expected/acceptable state hits a forbidden rule; ids, claim links, trace events and
     open-question ids resolve.
 11. Dataset shape: drafts marked correctly, and every scenario scores both failure types.

Usage: python scripts/validate_scenarios.py [dataset.json] [--related pharmacy.json] [--open-questions FILE]
Exit code 0 = all checks passed.
"""
import argparse
import copy
import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

sys.path.insert(0, str(Path(__file__).resolve().parent))
from calendar_lib import is_valid_slot, occupied_slots  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PHARM_NAME, SCHED_NAME = "harbor-pharmacy-call-scenarios", "harbor-clinic-scheduling-scenarios"
ap = argparse.ArgumentParser()
ap.add_argument("data", nargs="?", default=str(ROOT / "pharmacy_call_scenarios.v2.json"))
ap.add_argument("--v1", default=str(ROOT / "pharmacy_call_scenarios.json"))
ap.add_argument("--schema", default=str(ROOT / "scenario.schema.json"))
ap.add_argument("--related", default=str(ROOT / "pharmacy_call_scenarios.v2.json"), help="dataset referenced by related_scenarios")
ap.add_argument("--open-questions", default=None)
args = ap.parse_args()

results = []  # (section, ok, message)


def report(section, ok, msg):
    results.append((section, ok, msg))


data = json.loads(Path(args.data).read_text(encoding="utf-8"))
v1 = json.loads(Path(args.v1).read_text(encoding="utf-8"))
schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
scns = data["scenarios"]
by_id = {s["id"]: s for s in scns}
v1_by_id = {s["id"]: s for s in v1["scenarios"]}
DOMAIN = "scheduling" if data.get("dataset") == SCHED_NAME else "pharmacy"
if args.open_questions is None:
    args.open_questions = str(ROOT / ("OPEN_QUESTIONS_SCHEDULING.md" if DOMAIN == "scheduling" else "OPEN_QUESTIONS.md"))

# ---------------------------------------------------------------- 1. schema
Draft202012Validator.check_schema(schema)
errs = sorted(Draft202012Validator(schema).iter_errors(data), key=lambda e: list(e.absolute_path))
for e in errs[:25]:
    report("schema", False, f"{'/'.join(map(str, e.absolute_path))}: {e.message[:200]}")
if not errs:
    report("schema", True, f"valid against {Path(args.schema).name} ({len(scns)} scenarios)")
else:
    print("\n".join(f"FAIL [schema] {m}" for _, _, m in results))
    sys.exit(1)  # later checks assume a schema-valid document

# ---------------------------------------------------------------- helpers
RX_FIELDS = {"rx_id"}
STORE_FIELDS = {"store_id", "from_store", "to_store"}


def where_values(v):
    if isinstance(v, dict):
        return v.get("in") or v.get("not_in") or []
    return [v]


def walk_refs(obj, out, fields):
    """Collect (field, value) for the given reference fields anywhere inside obj (including in/not_in lists)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in fields and not isinstance(v, list):
                for val in where_values(v):
                    out.append((k, val))
            else:
                walk_refs(v, out, fields)
    elif isinstance(obj, list):
        for x in obj:
            walk_refs(x, out, fields)


def match_value(actual, cond):
    if isinstance(cond, dict):
        if "in" in cond:
            return actual in cond["in"]
        if "not_in" in cond:
            return actual not in cond["not_in"]
    return actual == cond


def rec_matches(rec, where):
    return all(k in rec and match_value(rec[k], v) for k, v in (where or {}).items())


PURE_STATE = {"state_contains", "state_not_contains", "state_count", "state_equals", "all_of", "any_of"}


def is_pure_state(chk):
    if chk["type"] in ("all_of", "any_of"):
        return all(is_pure_state(c) for c in chk["checks"])
    return chk["type"] in PURE_STATE


def eval_state(chk, st):
    t = chk["type"]
    if t == "state_contains":
        return any(rec_matches(r, chk["where"]) for r in st.get(chk["collection"], []))
    if t == "state_not_contains":
        return not any(rec_matches(r, chk["where"]) for r in st.get(chk["collection"], []))
    if t == "state_count":
        n = sum(rec_matches(r, chk["where"]) for r in st.get(chk["collection"], []))
        return {"eq": n == chk["value"], "lte": n <= chk["value"], "gte": n >= chk["value"]}[chk["op"]]
    if t == "state_equals":
        return st[chk["field"]] == chk["value"]
    if t == "all_of":
        return all(eval_state(c, st) for c in chk["checks"])
    if t == "any_of":
        return any(eval_state(c, st) for c in chk["checks"])
    raise ValueError(t)


def iter_events(chk):
    if isinstance(chk, dict):
        if "event" in chk and isinstance(chk["event"], str):
            yield chk["event"]
        for v in chk.values():
            yield from iter_events(v)
    elif isinstance(chk, list):
        for x in chk:
            yield from iter_events(x)


def collect_refs(s, fields):
    refs = []
    for part in (s["expected_end_state"], s["forbidden_state"], [a["end_state_delta"] for a in s["acceptable_outcomes"]],
                 s["grading"]["state_checks"], s["grading"]["claim_checks"]):
        walk_refs(part, refs, fields)
    return refs


# ---------------------------------------------------------------- 2. referential integrity
ref_fail = 0
if DOMAIN == "pharmacy":
    dir_stores = {s["id"] for s in data["stores"]}
    for s in scns:
        fx = s["pharmacy_fixture"]
        stores = set(fx["store_ids"])
        rxs = {rx["rx_id"] for p in fx["patients"] for rx in p["prescriptions"]}
        for st in stores - dir_stores:
            report("refs", False, f"{s['id']}: fixture store {st} not in top-level stores"); ref_fail += 1
        for p in fx["patients"]:
            for rx in p["prescriptions"]:
                if rx["store_id"] not in stores:
                    report("refs", False, f"{s['id']}: {rx['rx_id']} held at {rx['store_id']} not in fixture store_ids"); ref_fail += 1
        refs = collect_refs(s, RX_FIELDS | STORE_FIELDS)
        refs += [(e["type"], e["value"]) for e in s["critical_entities"] if e["type"] in ("rx_id", "store_id")]
        for field, val in refs:
            pool = rxs if field in RX_FIELDS else stores
            if val not in pool:
                report("refs", False, f"{s['id']}: {field}={val} not in scenario fixture"); ref_fail += 1
    if not ref_fail:
        report("refs", True, "every rx_id/store_id in end states, forbidden states, checks and critical_entities exists in its fixture")
else:
    CAL = data["calendar"]
    PROV_BY_ID = {p["id"]: p["name"] for p in data["providers"]}
    CODES = set(PROV_BY_ID)
    VT = data["visit_types"]
    for s in scns:
        fx = s["clinic_fixture"]
        codes = set(fx["provider_ids"])
        names = {PROV_BY_ID[c] for c in codes if c in PROV_BY_ID}
        patients = {p["name"] for p in fx["patients"]}
        appt_ids = {a["appointment_id"] for a in fx["appointments"]}
        for c in codes - CODES:
            report("refs", False, f"{s['id']}: fixture provider id {c} not in top-level providers"); ref_fail += 1
        for p in fx["patients"]:
            if p["provider_of_record"] not in PROV_BY_ID.values():
                report("refs", False, f"{s['id']}: provider_of_record {p['provider_of_record']} is not a clinic provider"); ref_fail += 1

        def slot_ok(slot):
            return is_valid_slot(CAL, CODES, slot) and slot[:3] in codes

        for a in fx["appointments"]:
            if not slot_ok(a["slot_id"]) or a["patient"] not in patients or a["visit_type"] not in VT or PROV_BY_ID.get(a["slot_id"][:3]) != a["provider"]:
                report("refs", False, f"{s['id']}: appointment {a['appointment_id']} has an invalid slot/patient/visit type/provider"); ref_fail += 1
        for slot in fx["open_slots"]:
            if not slot_ok(slot):
                report("refs", False, f"{s['id']}: open slot {slot} is not a calendar slot for a fixture provider"); ref_fail += 1
        refs = collect_refs(s, {"slot_id", "appointment_id", "provider", "visit_type", "patient"})
        refs += [(e["type"], e["value"]) for e in s["critical_entities"] if e["type"] in ("slot_id", "appointment_id", "provider")]
        for field, val in refs:
            ok = {"slot_id": lambda v: slot_ok(v),
                  "appointment_id": lambda v: v in appt_ids or (v.startswith("APT-NEW-") and slot_ok(v[8:])),
                  "provider": lambda v: v in names,
                  "visit_type": lambda v: v in VT,
                  "patient": lambda v: v in patients}[field](val)
            if not ok:
                report("refs", False, f"{s['id']}: {field}={val} does not resolve in the scenario fixture/calendar"); ref_fail += 1
    if not ref_fail:
        report("refs", True, "every slot_id is a real calendar slot for a fixture provider; every appointment_id, provider, patient and visit type resolves")

# ---------------------------------------------------------------- 3. declared vocabulary (tools, collections)
DECL_TOOLS = {t.split("(")[0].strip() for t in data["agent_context"]["tools"]}
DECL_COLLS = set(data["state_model"]["collections"]) - {"identity_verified"}


def used_tools(obj, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "tool":
                out.update([v] if isinstance(v, str) else v)
            elif k in ("tools", "source_tool"):
                out.update(v if isinstance(v, list) else [v])
            else:
                used_tools(v, out)
    elif isinstance(obj, list):
        for x in obj:
            used_tools(x, out)


def used_colls(obj, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "collection":
                out.add(v)
            else:
                used_colls(v, out)
    elif isinstance(obj, list):
        for x in obj:
            used_colls(x, out)


voc_fail = 0
for s in scns:
    t, c = set(), set()
    used_tools([s["grading"], s.get("tool_faults", [])], t)
    used_colls([s["grading"], s["forbidden_state"]], c)
    for x in sorted(t - DECL_TOOLS):
        report("vocabulary", False, f"{s['id']}: uses undeclared tool {x}"); voc_fail += 1
    for x in sorted(c - DECL_COLLS):
        report("vocabulary", False, f"{s['id']}: uses undeclared state collection {x}"); voc_fail += 1
    if set(s["expected_end_state"]) != DECL_COLLS | {"identity_verified"}:
        report("vocabulary", False, f"{s['id']}: expected_end_state keys differ from state_model collections"); voc_fail += 1
    for a in s["acceptable_outcomes"]:
        if not set(a["end_state_delta"]) <= DECL_COLLS | {"identity_verified"}:
            report("vocabulary", False, f"{s['id']}.{a['id']}: delta uses undeclared collections"); voc_fail += 1
if not voc_fail:
    report("vocabulary", True, f"all tools ({len(DECL_TOOLS)}) and state collections ({len(DECL_COLLS)}) used anywhere are declared; every end state lists exactly the declared collections")

# ---------------------------------------------------------------- 4. calendar (scheduling)
if DOMAIN == "scheduling":
    cal_fail = 0
    for s in scns:
        fx = s["clinic_fixture"]
        occ = {}
        for a in fx["appointments"]:
            need = occupied_slots(CAL, a["slot_id"], VT[a["visit_type"]]["minutes"])
            if need is None:
                report("calendar", False, f"{s['id']}: {a['appointment_id']} ({a['visit_type']}) runs past the end of the day"); cal_fail += 1
                continue
            for x in need:
                if x in occ:
                    report("calendar", False, f"{s['id']}: slot {x} double-booked by {occ[x]} and {a['appointment_id']}"); cal_fail += 1
                occ[x] = a["appointment_id"]
        for x in fx["open_slots"]:
            if x in occ:
                report("calendar", False, f"{s['id']}: slot {x} is both open and booked by {occ[x]}"); cal_fail += 1
        open_set = set(fx["open_slots"])
        states = [("expected", s["expected_end_state"])] + [(a["id"], a["end_state_delta"]) for a in s["acceptable_outcomes"]]
        for label, st in states:
            for b in st.get("bookings", []):
                need = occupied_slots(CAL, b["slot_id"], VT[b["visit_type"]]["minutes"])
                if need is None or not all(x in open_set for x in need):
                    report("calendar", False, f"{s['id']} {label}: booking {b['slot_id']} ({b['visit_type']}) does not fit entirely in open slots"); cal_fail += 1
                if PROV_BY_ID.get(b["slot_id"][:3]) != b["provider"]:
                    report("calendar", False, f"{s['id']} {label}: booking provider does not match its slot"); cal_fail += 1
    if not cal_fail:
        n_open = sum(len(s["clinic_fixture"]["open_slots"]) for s in scns)
        n_appt = sum(len(s["clinic_fixture"]["appointments"]) for s in scns)
        report("calendar", True, f"no double-booked slot in any starting fixture ({n_appt} appointments, {n_open} open slots); every appointment and every expected/acceptable booking fits its visit length in open slots")

# ---------------------------------------------------------------- 3. policies + escalation
pol_ids = {p["id"] for p in data["policies"]}
tier_pol = {p["tier"]: p["id"] for p in data["policies"] if "tier" in p}
EXPECT_ESC = {"none": (False, "none", None), "pharmacist": (True, "pharmacist", "before call end"),
              "doctor_today": (True, "prescriber", "before call end"), "emergency_911": (True, "911", "before any task action"),
              "nurse_same_day": (True, "nurse_line", "before call end")}
pol_fail = 0
for s in scns:
    for r in s["policy_refs"]:
        if r not in pol_ids:
            report("policies", False, f"{s['id']}: unknown policy_ref {r}"); pol_fail += 1
    if tier_pol[s["urgency_tier"]] not in s["policy_refs"]:
        report("policies", False, f"{s['id']}: missing tier policy {tier_pol[s['urgency_tier']]}"); pol_fail += 1
    esc = s["escalation"]
    if (esc["required"], esc["target"], esc["latest_acceptable_turn"]) != EXPECT_ESC[s["urgency_tier"]]:
        report("policies", False, f"{s['id']}: escalation block does not match urgency_tier {s['urgency_tier']}"); pol_fail += 1
added = [p["id"] for p in data["policies"] if p["source"].endswith("needs_review")]
decided = [p["id"] for p in data["policies"] if p["source"].startswith("author_decision")]
if not pol_fail:
    report("policies", True, f"all policy_refs resolve ({len(pol_ids)} policies; {len(decided)} from author decisions; {len(added)} marked needs_review); escalation matches urgency_tier in every scenario")

# ---------------------------------------------------------------- 4. v1 item mapping
map_fail = 0
mapped_total = 0
for s in scns:
    origin = s.get("parent_id") or s["id"]
    if origin not in v1_by_id:
        continue  # new drafts (S22, S23) have no v1 items
    g1 = v1_by_id[origin]["grading"]
    expected = {}
    for i, t in enumerate(g1["must_do"], 1):
        expected[f"{origin}.must_do.{i}"] = ("must_do", t, None)
    for i, it in enumerate(g1["must_not_do"], 1):
        expected[f"{origin}.must_not_do.{i}"] = ("must_not_do", it["text"], it["failure_type"])
    seen = {}
    for lst in ("state_checks", "judged_checks", "retired_v1_items"):
        for c in s["grading"].get(lst, []):
            if c["source"] == "v2_added":
                continue
            seen.setdefault(c["source"], []).append((lst, c))
    for src, (kind, text, ft) in expected.items():
        hits = seen.get(src, [])
        if len(hits) != 1:
            report("mapping", False, f"{s['id']}: {src} mapped {len(hits)} times"); map_fail += 1
            continue
        _, c = hits[0]
        if c["text"] != text or c["kind"] != kind or c.get("failure_type") != ft:
            report("mapping", False, f"{s['id']}: {src} text/kind/failure_type differs from v1"); map_fail += 1
        mapped_total += 1
    for src in seen:
        if src not in expected:
            report("mapping", False, f"{s['id']}: check source {src} is not an item of {origin}"); map_fail += 1
retired_total = sum(len(s["grading"].get("retired_v1_items", [])) for s in scns)
if not any((s.get("parent_id") or s["id"]) in v1_by_id for s in scns):
    report("mapping", True, "n/a: no scenario in this dataset derives from the v1 pharmacy file")
elif not map_fail:
    report("mapping", True, f"all v1 grading items accounted for exactly once, text unchanged ({mapped_total} item-placements across "
           f"{sum(1 for s in scns if (s.get('parent_id') or s['id']) in v1_by_id)} scenarios; {retired_total} retired with a stated reason)")

# ---------------------------------------------------------------- 4b. persona fields vs v1
PERSONA_FIELDS = ["caller", "disclosure_rules", "scripted_moves", "caller_stop_conditions"]
pers_fail = 0
changed_scns = []
for s in scns:
    origin = s.get("parent_id") or s["id"]
    if origin not in v1_by_id:
        continue
    logged = [c["field"] for c in s.get("persona_changes_v2", [])]
    diffs = []
    for fld in PERSONA_FIELDS:
        a, b = v1_by_id[origin][fld], s[fld]
        if a == b:
            continue
        if isinstance(a, list) and isinstance(b, list):
            n = max(len(a), len(b))
            diffs += [f"{fld}[{i}]" for i in range(n) if (a[i] if i < len(a) else None) != (b[i] if i < len(b) else None)]
        else:
            diffs.append(fld)
    for d in diffs:
        if d not in logged:
            report("persona", False, f"{s['id']}: {d} differs from v1 but is not recorded in persona_changes_v2"); pers_fail += 1
    for l in logged:
        if l not in diffs:
            report("persona", False, f"{s['id']}: persona_changes_v2 lists {l}, but it matches v1"); pers_fail += 1
    if diffs:
        changed_scns.append(f"{s['id']}({', '.join(diffs)})")
if not any((s.get("parent_id") or s["id"]) in v1_by_id for s in scns):
    report("persona", True, "n/a: no v1 caller scripts in this dataset (twin and fault rules below still constrain the caller scripts)")
elif not pers_fail:
    report("persona", True, "v1 persona fields unchanged except documented changes: " + ("; ".join(changed_scns) or "none"))

# ---------------------------------------------------------------- 5. fault variants
ALLOWED_DIFF = {"id", "title", "category", "parent_id", "tool_faults", "fault_notes", "harness_integrity_case",
                "expected_end_state", "forbidden_state", "acceptable_outcomes", "unique_outcome_reason", "grading"}
fault_fail = 0
faults = [s for s in scns if s["category"] == "fault"]
for f in faults:
    p = by_id.get(f["parent_id"])
    if p is None:
        report("faults", False, f"{f['id']}: parent {f['parent_id']} missing"); fault_fail += 1
        continue
    keys = set(f) | set(p)
    diff = sorted(k for k in keys if f.get(k) != p.get(k) and k not in ALLOWED_DIFF)
    if diff:
        report("faults", False, f"{f['id']}: differs from {p['id']} outside tool_faults/grading: {diff}"); fault_fail += 1
if not fault_fail:
    report("faults", True, f"{len(faults)} fault variants differ from their parents only in tool_faults + grading fields ({', '.join(x['id'] for x in faults)})")

# ---------------------------------------------------------------- 5b. declared twins
TWIN_ALWAYS = {"id", "title", "category", "hard_case_tags", "status", "twin_of", "twin_varies",
               "expected_end_state", "forbidden_state", "acceptable_outcomes", "unique_outcome_reason", "grading"}
twin_fail = 0
twins = [s for s in scns if "twin_of" in s]
for t in twins:
    b = by_id.get(t["twin_of"])
    if b is None:
        report("twins", False, f"{t['id']}: twin_of {t['twin_of']} missing"); twin_fail += 1
        continue
    declared = set(t["twin_varies"])
    diff = {k for k in set(t) | set(b) if t.get(k) != b.get(k)}
    for k in sorted(diff - declared - TWIN_ALWAYS):
        report("twins", False, f"{t['id']}: differs from {b['id']} in undeclared field {k}"); twin_fail += 1
    for k in sorted(declared - diff):
        report("twins", False, f"{t['id']}: declares {k} as varied, but it is identical to {b['id']}"); twin_fail += 1
if not twins:
    report("twins", True, "n/a: no declared twins in this dataset")
elif not twin_fail:
    report("twins", True, "declared twins differ only in their declared variable: " +
           "; ".join(f"{t['id']}~{t['twin_of']} ({', '.join(t['twin_varies'])})" for t in twins))

# ---------------------------------------------------------------- 5c. cross-dataset links
links = [(s["id"], r) for s in scns for r in s.get("related_scenarios", [])]
links += [(s["id"], x["related"]) for s in scns for x in s.get("clinic_fixture", {}).get("external_records", []) if "related" in x]
if links:
    rel_fail = 0
    related = json.loads(Path(args.related).read_text(encoding="utf-8"))
    rel_ids = {x["id"] for x in related["scenarios"]}
    for sid, r in links:
        if r["dataset"] != related["dataset"]:
            report("related", False, f"{sid}: links to unknown dataset {r['dataset']}"); rel_fail += 1
        elif r["scenario_id"] not in rel_ids:
            report("related", False, f"{sid}: {r['dataset']} has no scenario {r['scenario_id']}"); rel_fail += 1
    if data["caller_sim_instructions"] != related["caller_sim_instructions"]:
        report("related", False, "caller_sim_instructions differ from the related dataset (they are shared)"); rel_fail += 1
    if not rel_fail:
        report("related", True, f"{len(links)} cross-dataset links resolve in {related['dataset']} ("
               + ", ".join(sorted({f'{sid}->{r["scenario_id"]}' for sid, r in links})) + "); caller_sim_instructions identical")
else:
    report("related", True, "n/a: no cross-dataset links")

# ---------------------------------------------------------------- 6. self-consistency
cons_fail = 0
cons_checked = 0
oq_text = Path(args.open_questions).read_text(encoding="utf-8") if Path(args.open_questions).exists() else None
oq_ids = set(re.findall(r"\bOQS?-\d{2}\b", oq_text)) if oq_text else None
for s in scns:
    g = s["grading"]
    exp = s["expected_end_state"]
    # ids unique + sequential
    for lst, kind in (("state_checks", "state"), ("judged_checks", "judged"), ("claim_checks", "claim")):
        ids = [c["id"] for c in g[lst]]
        want = [f"{s['id']}.{kind}.{i}" for i in range(1, len(ids) + 1)]
        if ids != want:
            report("consistency", False, f"{s['id']}: {lst} ids not sequential"); cons_fail += 1
    claim_ids = {c["id"] for c in g["claim_checks"]}
    for c in g["judged_checks"]:
        if "linked_claim_check" in c and c["linked_claim_check"] not in claim_ids:
            report("consistency", False, f"{c['id']}: linked claim {c['linked_claim_check']} missing"); cons_fail += 1
    # trace events declared and in range
    declared = s.get("trace_events", {})
    for name, ref in declared.items():
        idx = int(re.search(r"\d+", ref).group(0))
        if idx >= len(s["scripted_moves"]):
            report("consistency", False, f"{s['id']}: trace event {name} -> {ref} out of range"); cons_fail += 1
    for ev in iter_events(g["state_checks"]):
        if ev not in declared:
            report("consistency", False, f"{s['id']}: check uses undeclared trace event {ev}"); cons_fail += 1
    # expected end state passes all pure state checks
    for c in g["state_checks"]:
        if is_pure_state(c["check"]):
            cons_checked += 1
            if not eval_state(c["check"], exp):
                report("consistency", False, f"{c['id']}: expected_end_state FAILS its own state check"); cons_fail += 1
    # expected end state violates no forbidden rule
    for fbd in s["forbidden_state"]:
        if any(rec_matches(r, fbd["where"]) for r in exp.get(fbd["collection"], [])):
            report("consistency", False, f"{s['id']}: expected_end_state matches forbidden rule on {fbd['collection']}"); cons_fail += 1
    # acceptable outcomes: apply delta; unless conditional, must pass state checks + forbidden rules
    for a in s["acceptable_outcomes"]:
        st = copy.deepcopy(exp)
        st.update(a["end_state_delta"])
        if st == exp:
            report("consistency", False, f"{s['id']}.{a['id']}: acceptable outcome identical to expected"); cons_fail += 1
        if "conditional_on_open_question" in a:
            continue
        for c in g["state_checks"]:
            if is_pure_state(c["check"]) and not eval_state(c["check"], st):
                report("consistency", False, f"{s['id']}.{a['id']}: acceptable outcome fails {c['id']}"); cons_fail += 1
        for fbd in s["forbidden_state"]:
            if any(rec_matches(r, fbd["where"]) for r in st.get(fbd["collection"], [])):
                report("consistency", False, f"{s['id']}.{a['id']}: acceptable outcome matches a forbidden rule"); cons_fail += 1
    # open questions referenced exist
    refs = set(s.get("depends_on_open_questions", []))
    if "pharmacy_fixture" in s:
        refs |= {rx.get("refills_open_question") for p in s["pharmacy_fixture"]["patients"] for rx in p["prescriptions"]} - {None}
    refs |= {a["conditional_on_open_question"] for a in s["acceptable_outcomes"] if "conditional_on_open_question" in a}
    if oq_ids is not None:
        for r in refs - oq_ids:
            report("consistency", False, f"{s['id']}: references {r}, not found in OPEN_QUESTIONS.md"); cons_fail += 1
if not cons_fail:
    msg = f"{cons_checked} pure state checks pass on their own expected_end_state; no expected/acceptable state hits a forbidden rule; ids, claim links and trace events resolve"
    msg += (f"; open-question refs resolve in {Path(args.open_questions).name}" if oq_ids is not None
            else f"; ({Path(args.open_questions).name} not found, open-question refs unchecked)")
    report("consistency", True, msg)

# ---------------------------------------------------------------- 7. dataset shape
shape_fail = 0
cats = {}
for s in scns:
    cats[s["category"]] = cats.get(s["category"], 0) + 1
drafts = [s["id"] for s in scns if s["status"] == "draft_needs_review"]
for d in drafts:
    if d in v1_by_id or by_id[d]["category"] == "fault":
        report("shape", False, f"{d}: only scenarios new in v2 (not v1 originals or fault variants) may be drafts"); shape_fail += 1
new_active = [s["id"] for s in scns if s["id"] not in v1_by_id and s["category"] != "fault" and s["status"] == "active"]
for s in scns:
    fts = {c.get("failure_type") for lst in ("state_checks", "judged_checks") for c in s["grading"][lst] if c["kind"] == "must_not_do"}
    if not {"over_caution", "carelessness"} <= fts:
        report("shape", False, f"{s['id']}: must_not_do checks do not cover both failure types"); shape_fail += 1
    if s["category"] == "control" and "over_caution" not in fts:
        report("shape", False, f"{s['id']}: control without an over_caution check"); shape_fail += 1
if not shape_fail:
    report("shape", True, "categories " + ", ".join(f"{k}={v}" for k, v in sorted(cats.items())) +
           f"; new & approved={new_active}; drafts={drafts}; every scenario scores both failure types")

# ---------------------------------------------------------------- output
ok_all = all(ok for _, ok, _ in results)
for sec, ok, msg in results:
    print(f"{'PASS' if ok else 'FAIL'} [{sec}] {msg}")
print()
print(f"{'ALL CHECKS PASSED' if ok_all else 'VALIDATION FAILED'}: {len(scns)} scenarios "
      f"({sum(len(s['grading']['state_checks']) for s in scns)} state checks, "
      f"{sum(len(s['grading']['judged_checks']) for s in scns)} judged checks, "
      f"{sum(len(s['grading']['claim_checks']) for s in scns)} claim checks)")
sys.exit(0 if ok_all else 1)
