"""Mutation tests for validate_scenarios.py: each planted defect must make validation fail
in the expected section. Usage: python scripts/test_validator.py"""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = json.loads((ROOT / "pharmacy_call_scenarios.v2.json").read_text(encoding="utf-8"))


def scn(d, sid):
    return next(s for s in d["scenarios"] if s["id"] == sid)


def m_drop_mapped_item(d):
    g = scn(d, "S05")["grading"]
    g["judged_checks"] = [c for c in g["judged_checks"] if c["source"] != "S05.must_not_do.1"]
    for i, c in enumerate(g["judged_checks"], 1):
        c["id"] = f"S05.judged.{i}"


def m_edit_item_text(d):
    scn(d, "S08")["grading"]["state_checks"][0]["text"] += " (edited)"


def m_fault_changes_persona(d):
    scn(d, "S01-F1")["caller"]["opening_line"] = "Hi."


def m_unknown_rx(d):
    scn(d, "S01")["expected_end_state"]["refills_queued"].append({"rx_id": "RX-FAKE", "store_id": "H-110"})


def m_unknown_store_in_check(d):
    scn(d, "S12")["grading"]["state_checks"][1]["check"]["where"]["to_store"] = "H-999"


def m_unknown_policy(d):
    scn(d, "S02")["policy_refs"].append("POL-XX-9")


def m_expected_hits_forbidden(d):
    scn(d, "S10")["expected_end_state"]["refills_queued"].append({"rx_id": "RX-GH-FURO20", "store_id": "H-110"})


def m_legacy_caregiver_field(d):
    scn(d, "S14")["pharmacy_fixture"]["patients"][0]["caregiver_authorization"] = "none on file"


def m_escalation_mismatch(d):
    scn(d, "S18")["escalation"]["target"] = "pharmacist"


def m_undeclared_event(d):
    scn(d, "S20").pop("trace_events")


def m_refills_null(d):
    scn(d, "S06")["pharmacy_fixture"]["patients"][0]["prescriptions"][1]["refills"] = None


def m_retired_without_reason(d):
    scn(d, "S13")["grading"]["retired_v1_items"][0]["reason"] = ""


def m_retired_and_mapped(d):
    g = scn(d, "S16")["grading"]
    r = g["retired_v1_items"][0]
    g["judged_checks"].append({"id": f"S16.judged.{len(g['judged_checks']) + 1}", "source": r["source"], "text": r["text"], "kind": r["kind"]})


def m_undocumented_persona_edit(d):
    scn(d, "S07")["caller"]["opening_line"] += " Hurry up."


def m_documented_change_removed(d):
    scn(d, "S11").pop("persona_changes_v2")


def m_fault_without_parent(d):
    scn(d, "S11-F1")["parent_id"] = "S99"


CASES = [
    (m_drop_mapped_item, "mapping"), (m_edit_item_text, "mapping"), (m_fault_changes_persona, "faults"),
    (m_unknown_rx, "refs"), (m_unknown_store_in_check, "refs"), (m_unknown_policy, "policies"),
    (m_expected_hits_forbidden, "consistency"), (m_legacy_caregiver_field, "schema"), (m_escalation_mismatch, "policies"),
    (m_undeclared_event, "consistency"), (m_refills_null, "schema"), (m_fault_without_parent, "faults"),
    (m_retired_without_reason, "schema"), (m_retired_and_mapped, "mapping"), (m_undocumented_persona_edit, "persona"),
    (m_documented_change_removed, "persona"),
]

# ---------------------------------------------------------------- scheduling dataset defects
SCHED = json.loads((ROOT / "scheduling_call_scenarios.v1.json").read_text(encoding="utf-8"))


def s_double_booked_fixture(d):
    scn(d, "A01")["clinic_fixture"]["open_slots"].append("PAT-20260929-1000")   # her own appointment's slot


def s_weekend_slot(d):
    scn(d, "A01")["expected_end_state"]["bookings"][0]["slot_id"] = "PAT-20261003-1400"   # a Saturday


def s_visit_does_not_fit(d):
    scn(d, "A03")["acceptable_outcomes"][0]["end_state_delta"]["bookings"][0]["slot_id"] = "PAT-20261002-0940"   # 40 min needs 10:00 too


def s_appointment_past_day_end(d):
    a = scn(d, "A04")["clinic_fixture"]["appointments"][1]
    a["slot_id"], a["visit_type"] = "BRA-20261008-1620", "annual_physical"


def s_twin_undeclared_diff(d):
    scn(d, "A02")["caller"]["opening_line"] += " Quickly, please."


def s_twin_false_declaration(d):
    scn(d, "A09")["twin_varies"].append("clinic_fixture")


def s_fault_twin_diverges(d):
    scn(d, "A05")["clinic_fixture"]["open_slots"].remove("PAT-20261002-0900")


def s_broken_cross_link(d):
    scn(d, "A08")["related_scenarios"][0]["scenario_id"] = "S99"


def s_foreign_collection(d):
    scn(d, "A01")["forbidden_state"].append({"collection": "refills_queued", "where": {}, "reason": "pharmacy collection in a clinic dataset"})


def s_unknown_appointment(d):
    scn(d, "A04")["expected_end_state"]["cancellations"][0]["appointment_id"] = "APT-IK-9999"


SCHED_CASES = [
    (s_double_booked_fixture, "calendar"), (s_weekend_slot, "refs"), (s_visit_does_not_fit, "calendar"),
    (s_appointment_past_day_end, "calendar"), (s_twin_undeclared_diff, "twins"), (s_twin_false_declaration, "twins"),
    (s_fault_twin_diverges, "faults"), (s_broken_cross_link, "related"), (s_foreign_collection, "vocabulary"),
    (s_unknown_appointment, "refs"),
]

failures = 0
total = 0
with tempfile.TemporaryDirectory() as tmp:
    for label, base, cases in (("pharmacy", BASE, CASES), ("scheduling", SCHED, SCHED_CASES)):
        print(f"--- {label} ---")
        for fn, section in cases:
            d = copy.deepcopy(base)
            fn(d)
            p = Path(tmp) / f"{fn.__name__}.json"
            p.write_text(json.dumps(d), encoding="utf-8")
            r = subprocess.run([sys.executable, str(ROOT / "scripts" / "validate_scenarios.py"), str(p)], capture_output=True, text=True)
            caught = r.returncode != 0 and f"FAIL [{section}]" in r.stdout
            failures += not caught
            total += 1
            first = next((l for l in r.stdout.splitlines() if l.startswith(f"FAIL [{section}]")), None) \
                or next((l for l in r.stdout.splitlines() if l.startswith("FAIL")), "(no FAIL line)")
            print(f"{'caught ' if caught else 'MISSED '} {fn.__name__:<28} -> {first[:110]}")
print(f"\n{total - failures}/{total} planted defects caught")
sys.exit(1 if failures else 0)
