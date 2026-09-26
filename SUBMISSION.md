# Submission: an evaluation lab for a healthcare voice agent

A lab that runs an AI pharmacy/clinic phone agent through realistic test calls, records everything, grades each call automatically with evidence pointing at the exact moment in the call, checks the grader against a pharmacy technician's judgment, and compares agent versions.

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
| 8 | Walkthrough video | *(link)* |

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

*Time limit:* the brief asks for eight hours within a 48-hour window. Kyron's founding engineer confirmed I could use the full 48 hours (NOTES.md, §8).

> **[YOUR WORDS]** Roughly how many hours on each: the scenarios and answer keys (Part 1), the harness and simulator, the grader, the app, reviewing calls and labelling, the experiment, and the writeups. From my side of the work, the big blocks in order were: the datasets and your open-question decisions (Thursday); the harness, simulator and model choice (Friday morning); the grader and app (Friday midday); three baseline runs to fix simulator leaks; your review of 16 calls; the experiment; the writeups.

### What I intentionally did not complete

- **Voice.** Calls are typed text, so speech-recognition errors, interruptions and silence aren't tested (see HARNESS.md).
- **Multiple trials per scenario.** The experiment ran one trial per scenario (a budget choice), so small differences between versions are within noise; EXPERIMENT.md says so.
- **A second reviewer.** Calibration reflects one reviewer (me).
- **Re-examining every answer key.** I fixed the ones the calibration and experiment surfaced (S03, S04, S06, S08, S11, S12, S20, S21); the rest weren't re-reviewed the same way.
- **The runtime guardrails I recommend** (tool-backed commitments, a separate symptom triage). They're designed in RECOMMENDATION.md, not built.

### How I used AI tools

> **[YOUR WORDS]** The brief asks for three things here: **(1)** how you used AI, **(2)** where its output was unreliable or generic, and **(3)** one consequential decision you made rather than delegated.
>
> For (2), real examples from this project:
> - Claude assumed "default store" and "home store" were different things. You corrected it, and two answer keys changed.
> - Its first simulated caller leaked hidden facts through sample lines and personas; it took three baseline runs to see and fix.
> - It gave the judge too small a budget, so the judge returned empty answers.
> - Its 400-token agent limit made the agent look silent.
> - Several numbers in its first drafts of these documents were wrong until checked against the data.
> - The local models it first suggested all claimed actions they never took.
>
> For (3), candidates: choosing to pay for the API after the local-model results; "home store = default store"; that the receiving pharmacy requests a transfer (REG-3); the stock/readiness rule; "never replace a 911 call with a callback"; approving the v2 rules.
>
> How you used it: For accuracy: Claude Code wrote the code, tests and draft documents. The pharmacy-practice decisions were yours and are logged in NOTES.md as [me], for example home store = default store, name + DOB is enough ID, the receiving pharmacy starts a transfer, stock promises, never replacing 911 with a callback, and the v2 rules. You reviewed and labelled 16 calls, which found the S21 and S08 problems. Claude models are also *inside* the lab (agent, caller, grader), and part of the work was checking them rather than trusting them: the simulator leaks, the empty judge replies, the 400-token cut-off.

### What I'd do next with more time

1. Run **5+ trials per scenario** for both versions, to put confidence intervals on the Part 5 comparison.
2. **Build the two runtime guardrails** from RECOMMENDATION.md and measure them with this lab: false commitments → 0, and safety scenarios passing on every trial.
3. **A second pharmacy reviewer**, plus a larger fixed calibration set, re-scored whenever the grader changes.
4. **Use a different model family for the judge**, so it doesn't share the simulated caller's blind spots.
5. **Voice:** put a speech-to-text and text-to-speech loop around the same harness, to test the failures typed text can't show.
