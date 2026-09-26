# Submission: an evaluation lab for a healthcare voice agent

A lab that runs an AI pharmacy/clinic phone agent through realistic test calls, records everything, grades each call automatically with evidence pointing at the exact moment in the call, checks the grader against a humans judgment, and compares agent versions.

**Start here:** `npm install`, then `npm run app` and open http://localhost:5174. It opens on the list of calls; open any call to see the conversation next to its grade. Setup details are in [README.md](README.md). **No API key is needed to review:** every model response is committed in `llm-cache/`, and all runs replay from it.

## What's where (the brief's "What to Submit" list)

| # | Deliverable | Where |
|---|---|---|
| 1 | Source code | `src/` (harness, evaluator, server), `web/` (app), `test/` (151 tests, no network) |
| 2 | Setup and run instructions | [README.md](README.md) |
| 3 | Scenario definitions | `pharmacy_call_scenarios.v2.json` (29), `scheduling_call_scenarios.v1.json` (9), schema `scenario.schema.json`, generators and validator in `scripts/`, notes in [DATASET.md](DATASET.md) |
| 4 | Evaluation prompts, logic and schemas | [EVALUATOR.md](EVALUATOR.md); `src/eval/` (checks, judge prompts, validity auditor); `trace.schema.json`; the simulator in [HARNESS.md](HARNESS.md) |
| 5 | Manual labels and comparison artifacts | `labels/labels.json` (168 finding labels + 16 call verdicts), [CALIBRATION.md](CALIBRATION.md), [EXPERIMENT.md](EXPERIMENT.md) |
| 6 | Output from completed evaluation runs | `runs/baseline-v1`, `runs/exp-v1`, `runs/exp-v2` (38 calls each: trace + evaluation + `index.jsonl`) |
| 7 | Product findings and production notes | [RECOMMENDATION.md](RECOMMENDATION.md), [PRODUCTION.md](PRODUCTION.md) |
| 8 | Walkthrough video | [Google Drive](https://drive.google.com/file/d/1eadM9c-RS6Qd6zIgQ8a1GLlp6YxM897Q/view?usp=sharing) |

Every decision I made is logged, with a reason, in [NOTES.md](NOTES.md).

## What's real, mocked and omitted

| | What | Notes |
|---|---|---|
| **Real** | The agent under test | Claude Haiku 4.5, with tool calling; its prompt is built only from the customer's policies, never from scenario data (tested) |
| **Real** | The simulated caller's words | Claude Sonnet 5 improvises in character; a deterministic "director" decides what it may reveal and when scripted moments happen |
| **Real** | The grader and the validity auditor | Code checks on records and the tool log; Claude Sonnet 5 for judgment calls |
| **Real** | Timing and failures | Faults (timeouts that do or don't go through, errors, silent failures, empty results) are injected deliberately and recorded |
| **Mocked** | Pharmacy and clinic systems | An in-memory world with 10 pharmacy and 8 clinic tools, built from the scenario data and the policy decisions in NOTES.md |
| **Mocked** | Patients, stores, prescriptions, calendars | All synthetic |
| **Omitted** | Voice | No speech recognition, speech synthesis, telephony, interruptions or silence; calls are typed text |
| **Omitted** | Real integrations | No real pharmacy system, EHR, directory of other pharmacies, insurance or billing |
| **Omitted** | Production concerns | Authentication, multi-tenancy, deployment (designed in PRODUCTION.md, not built) |

## External services

- **Anthropic API**, only to record *new* calls: Claude Haiku 4.5 as the agent under test; Claude Sonnet 5 as the simulated caller, grader and validity auditor. Keys go in a gitignored `.env` (see `.env.example`).
- **Reviewing needs no key and no network:** replay reads the committed cache.
- Local models (Ollama) were tried first and rejected; see `research/model-comparison/`.

## Summary

### Where I spent my time


I spent the time in roughly this order, with the biggest share on the first two blocks:

1. **Scenarios and answer keys (Part 1): the largest block.** I generated a first set of 21 pharmacy calls from caller perspectives, then reworked them against real pharmacy practice. That meant answering about 30 open questions on identity, caregivers, controlled substances, transfers and stock. I then added three scenarios, five fault variants, a nine-call clinic scheduling workflow, and a validator that checks every answer key.
2. **The harness and simulator (Part 2): the second-largest.** A mock pharmacy and clinic with fault injection, a live agent, and a simulated caller whose brief is enforced in code. This included choosing the agent model: local models first, then a paid API when they failed. It took three baseline runs to stop the simulated caller leaking hidden facts.
3. **The grader and the app (Parts 3–4):** code checks on the records, an LLM judge, the claim-timing logic, and the review app, including two passes to make it readable for someone new.
4. **Reviewing calls (Part 3):** I reviewed 16 calls by hand in the app. That surfaced the S21 simulator bug, the home-store/default-store error, and the answer-key problems described in CALIBRATION.md.
5. **The experiment (Part 5):** designing the v2 rules, running both versions, and investigating the regressions.
6. **The writeups and this video.**

### What I intentionally did not complete

- **Voice.** Calls are typed text, so speech-recognition errors, interruptions and silence aren't tested (see HARNESS.md).
- **Multiple trials per scenario.** The experiment ran one trial per scenario (a budget choice), so small differences between versions are within noise; EXPERIMENT.md says so.
- **A second reviewer.** Calibration reflects one reviewer (me).
- **Re-examining every answer key.** I fixed the ones the calibration and experiment surfaced (S03, S04, S06, S08, S11, S12, S20, S21); the rest weren't re-reviewed the same way.
- **The runtime guardrails I recommend** (tool-backed commitments, a separate symptom triage). They're designed in RECOMMENDATION.md, not built.

### How I used AI tools

**How I used it.** I worked with Claude Code throughout. It wrote nearly all of the code, tests and first drafts of these documents, and I directed the work milestone by milestone. My part was the judgment: every pharmacy-practice decision (logged in NOTES.md with my reasons, tagged [me]), approving the scenarios and answer keys, reviewing the traces, and labelling calls. I also used a multi-perspective brainstorming plugin to generate the first 21 scenarios from the point of view of different callers. AI models are also *inside* the lab (the agent, the simulated caller, the grader), so a large part of the work was checking them rather than trusting them.

**Where its output was unreliable or generic:**
- **It modelled the pharmacy wrong where it lacked domain knowledge.** It assumed a patient's "default store" and "home store" were different things. In a real pharmacy system they're the same, and the mistake led two answer keys to require the agent to "set" a store that was already the default. I caught it while reviewing S08.
- **Its simulator looked fine but wasn't.** The first simulated caller leaked hidden facts through sample lines and persona text, and volunteered details it was only supposed to give when asked. It took three baseline runs, and moving the rules from instructions into code, to make it a fair test.
- **Several plausible-looking settings were wrong.** The judge's token budget was too small, so it returned empty answers. The 400-token limit on the agent cut replies off mid-action, which made the agent look silent. We only found that by reading the raw responses during the experiment.
- **Its first drafts of these documents had wrong numbers** (call counts, sample splits, which transfers failed) until each was checked against the data.
- **The local models it first recommended** all claimed actions they never took, which is what pushed me to a paid API.

**One consequential decision I made rather than delegated: a human-in-the-loop review of the evaluator's own output, built into the product.**

The easy path was to let the LLM grader's verdicts stand as the result. I decided instead that, for every judgment-based metric, **human review is the ground truth and the automated evaluator is an estimator that has to be calibrated against it**, and that this review loop belongs in the product itself, not a one-off check:

1. **Label the evaluator's output, not the raw calls.** In the app, the reviewer marks each finding (required outcome, claim, caller-handling check) and the call's overall verdict as Pass or Fail, with a note. Labels persist to `labels/labels.json`, are versioned with the repo, and override the automated verdict everywhere downstream (pass rates, comparisons, failure patterns).
2. **Measure agreement per evaluator component,** not as one number: percent agreement and Cohen's κ, split by source (deterministic state checks, LLM-detected claims, LLM-judged behaviors, overall verdict), plus the direction of each disagreement (evaluator too lenient vs. too strict).
3. **Root-cause every disagreement** into one of four classes, because each has a different owner and fix: an evaluator error, a rubric gap (a standard no check encodes), an answer-key error, or a simulator artifact (the run wasn't a fair test).
4. **Revise the right layer, then re-grade and re-measure.**

**What it caught** in 16 reviewed calls and 184 labels:
- a **simulator defect**: S21 ended before its scripted emergency, so the agent was graded on a situation it never saw;
- a **world-model error**: the mock pharmacy treated "home store" and "default store" as different things;
- **three answer-key errors**, and **four rubric gaps**.

**What the numbers showed:** the evaluator agrees with me on 98% of individual findings (κ 0.86) but only 63% of call-level verdicts (κ 0.21). A re-run after fixing the answer keys showed call-level agreement **didn't move**. That told me the remaining gap is structural (unencoded standards plus all-or-nothing aggregation), not a grading bug, and the loop is what made that measurable rather than a guess.

**Why it's consequential:** it changed the dataset (2.1.1), the simulator (director 1.1.0), the agent (two of the v2 rules come straight from my review notes), and how the Part 5 result is reported (the pass rate turned out to be too fragile to headline). In production, the same loop becomes continuous: stratified sampling for review, a fixed calibration set re-scored on every evaluator change, and drift alerts. See PRODUCTION.md §4 and §6.

### What I'd do next with more time

1. Run **5+ trials per scenario** for both versions, to put confidence intervals on the Part 5 comparison.
2. **Build the two runtime guardrails** from RECOMMENDATION.md and measure them with this lab: false commitments → 0, and safety scenarios passing on every trial.
3. **A second pharmacy reviewer**, plus a larger fixed calibration set, re-scored whenever the grader changes.
4. **Use a different model family for the judge**, so it doesn't share the simulated caller's blind spots.
5. **Voice:** put a speech-to-text and text-to-speech loop around the same harness, to test the failures typed text can't show.
