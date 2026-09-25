# Kyron Medical: Healthcare Voice-Agent Evaluation (Part 1: Modeling the Evaluation Problem)

This repo holds the evaluation scenarios for a healthcare voice agent, across **two workflows** that share one schema, check vocabulary and validator:

| Workflow | Customer (fictional) | File | Scenarios |
|---|---|---|---|
| 1. Prescription refills/renewals, pharmacy changes/transfers, urgent-symptom routing | Harbor Pharmacy | `pharmacy_call_scenarios.v2.json` (v2.1.0) | **29**: 7 control, 3 ordinary, 14 hard, 5 tool-fault |
| 2. Appointment scheduling (book, cancel, reschedule, triage) | Harbor Family Medicine | `scheduling_call_scenarios.v1.json` (v1.0.0) | **9**: 2 control, 1 ordinary, 5 hard, 1 tool-fault |

The pharmacy set carries the depth. The scheduling set is deliberately small: it shows the design generalizes and adds cross-workflow cases (e.g. a clinic call that continues a pharmacy renewal).

Each scenario defines:
- the caller's goal and what they reveal, and when;
- the data the tools see;
- the relevant policies;
- the **exact tool-state end state** after a correct call;
- critical entities;
- escalation conditions;
- which evidence is deliberately unavailable.

Grading is split three ways:
- **state checks:** deterministic, run against the end state and the tool log;
- **judged checks:** conversation quality;
- **claim checks:** is what the agent *said* true? This is how the datasets catch an agent that claims completion when the tool action never happened, such as a reschedule that booked the new slot but left the old appointment on the calendar.

## Start here

| File | What it is |
|---|---|
| [`DATASET.md`](DATASET.md) | Dataset card for both workflows: scenario tables, twins and pairs, **ground truth** (and what can't be established from a transcript), limitations. Workflow 2 is section 7. |
| [`review/SAMPLE_SCENARIOS.md`](review/SAMPLE_SCENARIOS.md) | Four pharmacy scenarios rendered end to end (control, hard, fault, 911) |
| [`pharmacy_call_scenarios.v2.json`](pharmacy_call_scenarios.v2.json) / [`scheduling_call_scenarios.v1.json`](scheduling_call_scenarios.v1.json) | The datasets |
| [`scenario.schema.json`](scenario.schema.json) + [`SCHEMA_CHANGELOG.md`](SCHEMA_CHANGELOG.md) | One JSON Schema (draft 2020-12) for both datasets, and every change to it |
| [`NOTES.md`](NOTES.md) | Author decision notes: every judgment call, with a one-line reason |
| [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md) / [`OPEN_QUESTIONS_SCHEDULING.md`](OPEN_QUESTIONS_SCHEDULING.md) | Decision logs and open questions, per workflow |
| [`GRADING_MAP.md`](GRADING_MAP.md) | Trace from every original pharmacy grading item to its v2 check (or its retirement reason) |
| [`pharmacy_call_scenarios.json`](pharmacy_call_scenarios.json) | The original v1 pharmacy scenarios, kept unchanged for traceability |
| [`docs/plans/`](docs/plans/) | Design notes: the caller perspective panel and canonical scenario facts |

## Validate

Requires Python 3.12+ and `jsonschema`.

```bash
pip install jsonschema
python scripts/validate_scenarios.py pharmacy_call_scenarios.v2.json
python scripts/validate_scenarios.py scheduling_call_scenarios.v1.json
python scripts/test_validator.py       # 26 planted defects across both datasets; all must be caught
```

The validator detects which dataset it is checking. It verifies:
- schema validity;
- that every referenced prescription, store, slot, appointment, provider and patient exists in the scenario's data;
- that only declared tools and state collections are used;
- that no clinic slot is double-booked and every booking fits its visit length;
- that policy references resolve;
- that original pharmacy grading items are all accounted for;
- that fault variants and declared twins differ only in what they declare;
- that cross-dataset links resolve (with identical caller-sim instructions);
- that each expected end state passes its own checks and hits no forbidden state.

## Simulation harness (Part 2, in progress)

A TypeScript harness that runs an agent through the scenarios without real phone calls and records a trace of every run. It records; it does not grade. See [`HARNESS.md`](HARNESS.md). Requires Node 22+.

```bash
npm install
npm run typecheck
npm test            # 132 tests, no network: trace schema, mock tools and faults, turn loop, goldens, agent, director, evaluator
```

**Models.** The agent under test is Claude Haiku 4.5 and the simulated caller is Claude Sonnet 5, both through Anthropic's OpenAI-compatible endpoint. Live runs need a key: copy `.env.example` to `.env` (gitignored) and fill in `AGENT_API_KEY` / `CALLER_API_KEY`. **Replay needs no key**: every model response is in the committed `llm-cache/`.

```bash
npm run sim -- show runs/baseline-v1/S20.t0.json   # read a saved call: transcript, validity, grading
npx tsx src/cli/smoke-sim.ts A02 live              # one new live call (needs .env)
npx tsx src/cli/smoke-sim.ts A02 --human           # you play the caller, typing, against the live agent
```

**Evaluate** a saved trace (see [`EVALUATOR.md`](EVALUATOR.md)):

```bash
npx tsx src/cli/evaluate.ts runs/baseline-v1/S20.t0.json replay
```

### The app (Part 4)

```bash
npm run app        # builds the frontend, then serves http://localhost:5174
```

It loads every committed run under `runs/<batch>/` (plus its `.eval.json`) into SQLite on start, so there's nothing to set up. Pages:

- **Runs**: every call, its verdict and headline numbers, filterable by batch and verdict.
- **Run detail**: the transcript with tool calls, results, state changes and simulator decisions. Next to it, the evaluation, where every check links to the turn it's about. Mark any item, or the run itself, **Pass/Fail** to review or override it. Labels are saved to `labels/labels.json`.
- **Compare**: two batches (e.g. agent v1 vs v2), metric deltas and per-scenario changes.
- **Failure patterns**: failed checks grouped across runs, plus failure type, false-claim type, category and tag pass rates.
- **Calibration**: evaluator vs. human agreement (Cohen's κ, too lenient / too strict) and every disagreement.

For development, run `npm run serve` and `npm run web:dev` (Vite on :5173, proxying the API).

### Running batches (the `sim` CLI)

```bash
npm run sim -- run  --batch baseline-v1                      # every active scenario against agent v1 (needs .env)
npm run sim -- run  --batch baseline-v1 --mode replay --force # reproduce it from the committed cache, no key
npm run sim -- list --batch baseline-v1                       # one line per call
npm run sim -- show runs/baseline-v1/S20.t0.json              # transcript, validity checks and grading
```

Each call is run, checked for validity (did the simulated caller play fair?) and graded, then saved under `runs/<batch>/`. See [`HARNESS.md`](HARNESS.md) sections 6–8.

## Regenerate

The datasets are generated. Edit the scripts, never the JSON by hand:

```bash
python scripts/build_v2.py               # pharmacy v2 (from v1 + recorded decisions) + GRADING_MAP.md
python scripts/build_scheduling_v1.py    # scheduling v1 (reads shared pieces from the pharmacy file)
python scripts/render_scenarios.py S05 S16 S11-F1 S21   # readable review sheet (pharmacy scenarios)
```

Pharmacy workflow in this repo (who starts a transfer, what an agent can know about another store's stock, how dosing questions are handled) reflects the author's first-hand experience as a pharmacy technician. All people, clinics, stores, prescriptions and appointments are fictional.
