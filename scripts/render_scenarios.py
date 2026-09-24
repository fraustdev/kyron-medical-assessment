"""Render scenarios from pharmacy_call_scenarios.v2.json as readable Markdown.

Every value is read from the JSON (nothing is retyped), so the Markdown is a faithful view of the data.
Usage: python scripts/render_scenarios.py S05 S16 S11-F1 S21 [-o review/SAMPLE_SCENARIOS.md]
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("ids", nargs="+")
ap.add_argument("-o", "--out", default=str(ROOT / "review" / "SAMPLE_SCENARIOS.md"))
ap.add_argument("--data", default=str(ROOT / "pharmacy_call_scenarios.v2.json"))
args = ap.parse_args()

data = json.loads(Path(args.data).read_text(encoding="utf-8"))
SCN = {s["id"]: s for s in data["scenarios"]}
STORES = {s["id"]: s for s in data["stores"]}
POL = {p["id"]: p for p in data["policies"]}


def esc(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def cond(v):
    if isinstance(v, dict) and "in" in v:
        return "∈ {" + ", ".join(map(str, v["in"])) + "}"
    if isinstance(v, dict) and "not_in" in v:
        return "∉ {" + ", ".join(map(str, v["not_in"])) + "}"
    return f"= {v}"


def where(w):
    return ", ".join(f"{k} {cond(v)}" for k, v in (w or {}).items()) or "any record"


def tools(t):
    return t if isinstance(t, str) else " / ".join(t)


def point(p):
    return f"event `{p['event']}`" if "event" in p else f"{tools(p['tool'])}({where(p.get('where'))})"


def check(c):
    t = c["type"]
    if t == "state_contains":
        return f"`{c['collection']}` CONTAINS a record where {where(c['where'])}"
    if t == "state_not_contains":
        return f"`{c['collection']}` has NO record where {where(c['where'])}"
    if t == "state_count":
        return f"count of `{c['collection']}` where {where(c['where'])} {c['op']} {c['value']}"
    if t == "state_equals":
        return f"`{c['field']}` = {c['value']}"
    if t == "tool_called":
        return f"tool log: {tools(c['tool'])} called where {where(c['where'])}"
    if t == "tool_not_called":
        return f"tool log: {tools(c['tool'])} NEVER called where {where(c['where'])}"
    if t == "tool_count":
        return f"tool log: number of {tools(c['tool'])} calls where {where(c['where'])} {c['op']} {c['value']}"
    if t == "tool_order":
        return f"order: {point(c['first'])} happens BEFORE {point(c['then'])}"
    if t == "tool_called_after":
        return f"tool log: {tools(c['tool'])}({where(c['where'])}) called AFTER {point(c['after'])}"
    if t == "no_tool_after_event":
        return f"no call to {', '.join(c['tools'])} after event `{c['event']}`"
    if t == "trace_metric":
        return f"{c['metric']} {c['op']} {c['value']}"
    if t == "arg_from_prior_tool_output":
        return f"every {c['tool']}.{c['arg']} was returned earlier by {c['source_tool']}"
    if t in ("all_of", "any_of"):
        j = " AND " if t == "all_of" else " OR "
        return "(" + j.join(check(x) for x in c["checks"]) + ")"
    if t == "never":
        return "NEVER true in this scenario"
    if t == "matches_tool_output":
        return f"stated value must equal {c['tool']} output field `{c['field']}`"
    if t == "fixture_contains":
        return f"fixture: {c['patient']}'s {c['field']} contains {where(c['where'])}"
    return json.dumps(c)


def record(r):
    return ", ".join(f"{k}={v}" for k, v in r.items())


def end_state(st):
    out = [f"- **identity_verified:** {st['identity_verified']}"]
    for k, v in st.items():
        if k == "identity_verified":
            continue
        out.append(f"- **{k}:** " + ("*(empty; nothing should happen here)*" if not v else "; ".join(f"`{record(r)}`" for r in v)))
    return out


def render(s):
    L = []
    L.append(f"# {s['id']}: {s['title']}")
    L.append("")
    meta = [f"**Category:** {s['category']}", f"**Status:** {s['status']}", f"**Task:** {s['task_type']}",
            f"**Workflow:** {', '.join(s['workflow'])}", f"**Urgency tier:** {s['urgency_tier']}",
            f"**Tags:** {', '.join(s['hard_case_tags']) or '(none)'}"]
    if s.get("parent_id"):
        meta.insert(0, f"**Fault variant of:** {s['parent_id']}")
    L.append(" · ".join(meta))
    L.append("")
    L.append(f"> **Success in one paragraph:** {s['grading']['success_summary']}")
    L.append("")

    if s.get("tool_faults"):
        L.append("## Injected tool fault")
        for f in s["tool_faults"]:
            extra = f", match {f['match']}" if f.get("match") else ""
            L.append(f"- `{f['tool']}` on call **{f['on_call']}** → **{f['behavior']}**" + (f" (value: `{json.dumps(f.get('value'))}`)" if f.get("value") is not None else "") + extra)
        L.append(f"- *Notes:* {s['fault_notes']}")
        L.append("")

    c = s["caller"]
    L.append("## 1. The caller (what the simulated caller is told)")
    L.append(f"- **Who:** {c['name']} ({c['role']}), calling about **{c['patient_name']}**")
    L.append(f"- **Persona:** {c['persona']}")
    L.append(f"- **Speaking style:** {c['speaking_style']}")
    L.append(f"- **Underlying goal:** {c['goal']}")
    L.append(f"- **Opening line:** \"{c['opening_line']}\"")
    L.append("- **Sample lines:** " + " · ".join(f"\"{x}\"" for x in c["sample_lines"]))
    L.append("")
    L.append("**What the caller knows and when they say it**")
    L.append("")
    L.append("| Fact | Revealed |")
    L.append("|---|---|")
    for r in s["disclosure_rules"]:
        when = r["reveal"] + (f": {r['trigger']}" if r.get("trigger") else "")
        L.append(f"| {esc(r['fact'])} | {esc(when)} |")
    L.append("")
    L.append("**Scripted moves** (each fires once, when its trigger first happens)")
    L.append("")
    for i, m in enumerate(s["scripted_moves"]):
        L.append(f"{i}. *When* {m['trigger']} → says: \"{m['say']}\"" + (f"  \n   *(added in v2: {m['added_in']})*" if m.get("added_in") else ""))
    L.append("")
    L.append("**Caller hangs up when:** " + " / ".join(s["caller_stop_conditions"]))
    L.append("")
    if s.get("persona_changes_v2"):
        L.append("**Changes to the v1 caller script (with reasons):**")
        for pc in s["persona_changes_v2"]:
            before = f"\"{pc['before']}\"" if pc["before"] is not None else "*(new)*"
            L.append(f"- `{pc['field']}`: {before} → \"{pc['after']}\". *Why:* {pc['reason']}")
        L.append("")

    fx = s["pharmacy_fixture"]
    L.append("## 2. The world (pharmacy data the tools see)")
    L.append("")
    L.append("**Stores in this scenario:** " + "; ".join(f"`{sid}` {STORES[sid]['name']}, {STORES[sid]['address']}" for sid in fx["store_ids"]))
    L.append("")
    for p in fx["patients"]:
        ac = ", ".join(f"{x['name']} ({x['relationship']}, {x['type']})" for x in p["authorized_contacts"]) or "none"
        rc = ", ".join(x["name"] for x in p["restricted_contacts"]) or "none"
        L.append(f"**Patient: {p['name']}**, DOB {p['dob']}, home store `{p['home_store']}` · authorized contacts: {ac} · restricted: {rc}")
        L.append("")
        L.append("| rx_id | Drug | Schedule | Status | Refills | Store | Prescriber | Notes |")
        L.append("|---|---|---|---|---|---|---|---|")
        for rx in p["prescriptions"]:
            notes = "; ".join(x for x in [rx.get("purpose"), rx.get("notes"), rx.get("data_note"),
                                           f"filled {rx['filled_date']}" if rx.get("filled_date") else None,
                                           f"earliest fill {rx['earliest_fill']}" if rx.get("earliest_fill") else None] if x)
            L.append(f"| `{rx['rx_id']}` | {esc(rx['drug'])} | {rx['schedule'] or '-'} | {rx['status']} | {rx['refills']} | `{rx['store_id']}` | {rx['prescriber'] or '-'} | {esc(notes)} |")
        L.append("")
    if fx.get("notes"):
        L.append(f"*Fixture note:* {fx['notes']}")
        L.append("")

    L.append("## 3. What the agent has, and what it can't know")
    a = s["agent_known_at_start"]
    L.append(f"- **At the start:** caller ID = {a['caller_id'] or 'not provided'}; preloaded patient = {a['preloaded_patient'] or 'none'}; has: {'; '.join(a['has'])}")
    L.append("- **Deliberately unavailable:**")
    for u in s["unavailable_evidence"]:
        L.append(f"  - {u}")
    L.append("")
    L.append("**Critical entities** (`act_on` = must be exactly right · `must_not_act_on` = touching it is an error · `reference` = context)")
    L.append("")
    L.append("| Type | Value | Role |")
    L.append("|---|---|---|")
    for e in s["critical_entities"]:
        L.append(f"| {e['type']} | {esc(e['value'])} | {e['role']} |")
    L.append("")

    L.append("## 4. Policies in play")
    for pid in s["policy_refs"]:
        p = POL[pid]
        L.append(f"- **{pid}: {p['title']}.** {p['text']}")
    L.append("")
    e = s["escalation"]
    L.append(f"**Escalation:** required = {e['required']} · target = {e['target']} · latest acceptable = {e['latest_acceptable_turn']}. {e['reason']}")
    L.append("")
    if s["human_involvement"]:
        L.append("**Human involvement:**")
        for h in s["human_involvement"]:
            L.append(f"- *{h['condition']}* → **{h['who']}** via {h['mechanism']}")
        L.append("")
    if s.get("trace_events"):
        L.append("**Trace events** (timestamps the checks refer to): " + "; ".join(f"`{k}` = {v}" for k, v in s["trace_events"].items()))
        L.append("")

    L.append("## 5. Ground truth: the end state after a correct call")
    L.extend(end_state(s["expected_end_state"]))
    L.append("")
    L.append("**Forbidden (fail if any of these exist):**")
    for f in s["forbidden_state"]:
        L.append(f"- `{f['collection']}` where {where(f['where'])}. *{f['reason']}*")
    L.append("")
    if s["acceptable_outcomes"]:
        L.append("**Also acceptable:**")
        for a in s["acceptable_outcomes"]:
            delta = "; ".join(f"{k} → " + (str(v) if not isinstance(v, list) else ("(empty)" if not v else ", ".join(f"`{record(r)}`" for r in v))) for k, v in a["end_state_delta"].items())
            L.append(f"- **{a['id']}:** {delta}. *{a['reason']}*")
    else:
        L.append(f"**Only one correct outcome:** {s['unique_outcome_reason']}")
    L.append("")

    g = s["grading"]
    L.append("## 6. Grading")
    L.append("")
    L.append("### State checks (deterministic: end state + tool log)")
    L.append("")
    L.append("| ID | From | Kind | Failure type | Item | Pass condition |")
    L.append("|---|---|---|---|---|---|")
    for c in g["state_checks"]:
        L.append(f"| {c['id']} | {c['source']} | {c['kind']} | {c.get('failure_type', '')} | {esc(c['text'])} | {esc(check(c['check']))} |")
    L.append("")
    L.append("### Judged checks (conversation quality: LLM judge now, human labels later)")
    L.append("")
    L.append("| ID | From | Kind | Failure type | Item |")
    L.append("|---|---|---|---|---|")
    for c in g["judged_checks"]:
        link = f" *(truth checked by {c['linked_claim_check']})*" if c.get("linked_claim_check") else ""
        L.append(f"| {c['id']} | {c['source']} | {c['kind']} | {c.get('failure_type', '')} | {esc(c['text'])}{link} |")
    L.append("")
    L.append("### Claim checks (if the agent SAYS this, is it TRUE?)")
    L.append("")
    L.append("| ID | If the agent says… | …it is only true when | Violation if false |")
    L.append("|---|---|---|---|")
    for c in g["claim_checks"]:
        extra = ""
        if c.get("must_not_precede"):
            extra += f" · must not be said before {c['must_not_precede']['tool']} returns {c['must_not_precede']['result']}"
        if c.get("attribution_rule"):
            extra += f" · {c['attribution_rule']}"
        L.append(f"| {c['id']} | {esc(c['claim'])} | {esc(check(c['true_iff']))}{esc(extra)} | {c['violation']} |")
    L.append("")
    if g.get("retired_v1_items"):
        L.append("### Retired v1 items (made incorrect by an author decision)")
        for r in g["retired_v1_items"]:
            L.append(f"- **{r['source']}** \"{r['text']}\". *Reason:* {r['reason']}")
        L.append("")
    return "\n".join(L)


out = Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
header = [f"# Scenario review sheet: {', '.join(args.ids)}", "",
          f"Rendered by `scripts/render_scenarios.py` from `{Path(args.data).name}` (version {data['version']}). "
          "Every value comes from the JSON; nothing is retyped.", "", "---", "", ""]
body = "\n\n---\n\n".join(render(SCN[i]) for i in args.ids)
out.write_text("\n".join(header) + body + "\n", encoding="utf-8")
print(f"wrote {out} ({len(args.ids)} scenarios)")
