# Kyron Medical: Healthcare Voice-Agent Evaluation (Part 1: Modeling the Evaluation Problem)

This repo holds the evaluation scenarios for a voice agent that answers a retail pharmacy's phone line. It covers three workflows: **prescription refills and renewals**, **pharmacy changes and transfers**, and **urgent-symptom routing** that cuts across both.

**29 scenarios** in all:
- 7 controls
- 3 ordinary
- 14 hard cases
- 5 tool-fault variants

Each scenario defines:
- the caller's goal and what they reveal, and when;
- the pharmacy data the tools see;
- the relevant policies;
- the **exact tool-state end state** after a correct call;
- critical entities;
- escalation conditions;
- which evidence is deliberately unavailable.

Grading is split three ways:
- **state checks:** deterministic, run against the end state and the tool log;
- **judged checks:** conversation quality;
- **claim checks:** is what the agent *said* true? This is how the dataset catches an agent that claims completion when the tool action never happened.

## Start here

| File | What it is |
|---|---|
| [`DATASET.md`](DATASET.md) | Dataset card: workflows, scenario table, paired scenarios, **ground truth** (and what can't be established from a transcript), limitations |
| [`review/SAMPLE_SCENARIOS.md`](review/SAMPLE_SCENARIOS.md) | Four scenarios rendered end to end (control, hard, fault, 911) |
| [`pharmacy_call_scenarios.v2.json`](pharmacy_call_scenarios.v2.json) | The dataset (v2.1.0) |
| [`scenario.schema.json`](scenario.schema.json) | JSON Schema (draft 2020-12) |
| [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md) | Decision log: every modeling decision and what it changed |
| [`GRADING_MAP.md`](GRADING_MAP.md) | Trace from every original grading item to its v2 check (or its retirement reason) |
| [`pharmacy_call_scenarios.json`](pharmacy_call_scenarios.json) | The original v1 scenarios, kept unchanged for traceability |
| [`docs/plans/`](docs/plans/) | Design notes: the caller perspective panel and canonical scenario facts |

## Validate

Requires Python 3.12+ and `jsonschema`.

```bash
pip install jsonschema
python scripts/validate_scenarios.py   # schema + cross-reference checks
python scripts/test_validator.py       # 16 planted defects; the validator must catch all of them
```

The validator checks:
- schema validity;
- that every rx_id/store_id exists in its scenario's data;
- that every policy reference resolves;
- that every original grading item is accounted for exactly once;
- that fault variants differ from their parents only in tool behavior and grading;
- that no original caller-script field changed without a recorded reason;
- that each expected end state passes its own checks and hits no forbidden state.

## Regenerate

The v2 dataset is generated from v1 plus recorded decisions. Edit `scripts/build_v2.py`, never the JSON by hand:

```bash
python scripts/build_v2.py                          # writes the v2 JSON + GRADING_MAP.md
python scripts/render_scenarios.py S05 S16 S11-F1 S21   # readable review sheet
```

Pharmacy workflow in this dataset (who starts a transfer, what an agent can know about another store's stock, how dosing questions are handled) reflects the author's first-hand experience as a pharmacy technician. All people, stores and prescriptions are fictional.
