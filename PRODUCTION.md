# Part 7: Turning this into a production evaluation system

The goal at thousands of calls a day is not "grade every call with an LLM". It's to catch the failures that matter (safety, false commitments, broken actions) fast and cheaply, to know how far to trust each signal, and to turn findings into owned work. What carries over from this prototype and what changes:

## What carries over as-is

- **One trace format** for everything (`trace.schema.json`): simulated, human-played and, in production, real calls. Every result points back to the exact moment in a call.
- **The split between code checks and LLM judgment.** Records and tool logs are checked by code. The LLM is only asked what needs reading comprehension, and a claim's truth is always decided against the records *at the moment it was said*.
- **Run validity.** A test the simulator didn't play fairly isn't scored.
- **The calibration loop.** Human labels measure each evaluator part separately, and disagreements feed back into the answer keys.

## 1. Two evaluation modes, not one

| | Pre-release (scenario suite) | Production monitoring (real calls) |
|---|---|---|
| Input | Simulated calls against the scenario set, several trials each | Real call transcripts + the agent runtime's tool log |
| Ground truth | Answer keys | None per call, so only checks that need no answer key |
| Checks | Everything in this repo | Claims vs. tool log (false commitments), safety triage (symptom mentioned → escalated?), policy rules (e.g. ID verified before any write), tool errors and retries |
| Output | Release gate | Alerts, trends, and a review queue |

## 2. Ingestion

- The agent runtime emits the trace itself: turns, tool calls and results, state changes. It isn't reconstructed afterwards. Voice adds speech-recognition text with confidence, interruptions and silences.
- Traces go to a queue → object storage (the immutable trace) → **Postgres** for metadata and results (replacing SQLite). Evaluation workers consume the queue, so evaluation never slows down a live call.

## 3. Versioning (everything a result depends on)

Every result is keyed by the versions that produced it: **agent** (prompt hash, model, tool definitions), **customer policy set**, **scenario dataset**, **simulator** (director version + model), and **evaluator** (check code, judge prompt, judge model). This prototype already records most of these in each trace. Two rules:

- A comparison changes exactly one of these at a time. Part 5 held everything but the agent prompt fixed, and still had to re-run calls when a harness limit turned out to affect both sides.
- **A judge-model upgrade is an evaluator change.** It must re-pass calibration before its numbers are trusted.

## 4. Human review sampling

- **100%** of calls where the safety triage fired, or where an automated check and the LLM judge disagree.
- **A small uniform random sample** (1–2% of calls), the only unbiased estimate of real failure rates.
- **Oversample** new agent versions, new customers and new policies for their first days.
- Reviewers use the same review UI as this app, with the same Pass/Fail labels. A second reviewer on ~10% measures reviewer agreement, which is the ceiling on what the evaluator can match.

## 5. Regression gates and release decisions

A new agent version ships only if:
1. **Safety scenarios pass on every trial** (5+ trials each), with no exceptions.
2. **False commitments = 0** on the suite.
3. **Required outcomes are not worse**, with a confidence interval rather than a single run. Part 5 showed a 2-point move is noise at one trial per scenario.
4. **Every scenario that regressed has been looked at by a person** and explained: a real regression, a rubric flaw or noise. In Part 5, two of three "regressions" were rubric flaws.

The overall pass rate is reported but never gates. It flipped sign when two answer-key flaws were fixed.

## 6. Evaluator drift

- Keep a **fixed, labelled calibration set** (like the 16 calls here, but larger and multi-reviewer). Re-score it on every evaluator change and on a schedule; alert if agreement drops.
- **Pin judge model versions.** This prototype's judge can't be made deterministic (Sonnet 5 doesn't accept a temperature setting), so for gating decisions use a majority of three judgments, and cache everything so any result replays exactly.
- **The judge shares a model with the simulated caller here.** In production, use a different model family for the judge, so blind spots aren't shared.

## 7. Privacy and security

- Real calls are PHI: business associate agreements (BAAs) with every model provider, zero-retention endpoints, encryption at rest and in transit, role-based access, and an audit log of who viewed which call.
- **Minimum necessary:** evaluators get the transcript and tool log, not the full patient record. De-identify before a call enters review or the calibration set.
- Retention limits on raw audio and transcripts. Scenario suites stay synthetic, as they are here. Keys live in a secret manager, never in the repo, and the cache never stores them.

## 8. Cost and latency

- **Measured here:** about **$0.07–0.08 per simulated call** (from the account balance; list prices put it nearer $0.11) for the whole pipeline (agent, simulated caller, director, judge and validity auditor). Roughly 70% of that is the simulator and judge, not the agent. A 38-scenario batch ran in about 6 minutes.
- **Production monitoring needs no simulator.** The cheapest checks (claims vs. tool log, policy rules, tool errors) are code, and run on 100% of calls. The LLM judge runs on the review sample and on flagged calls, not everything.
- At 5,000 calls a day, judging every call would be roughly $100–150 a day at this project's per-call judge cost; judging a 10% sample plus flagged calls is roughly $15–25 a day.
- Latency only matters for the **runtime guardrails** (the pre-speech commitment check and the symptom triage from RECOMMENDATION.md). Those need a small, fast model, or rules, inside the call. Everything else is asynchronous.

## 9. Customer-specific policies

- Policies are **data, versioned per customer**, as in this dataset's policy list. Examples are ID requirements, who counts as an authorized caregiver, whether the agent may promise a ready time, and escalation lines.
- Scenarios reference policy ids, so a policy change re-runs exactly the scenarios that depend on it.
- The agent prompt is rendered from the customer's policy version, and the evaluator grades against the same version.
- This project showed why that matters: "home store = default store" and "the agent may promise readiness at its own store" were customer-practice decisions that changed the answer keys.

## 10. Observability and debugging

- Every alert links to a call page like this app's: the story, the timeline, and the finding pointing at the turn.
- Keep the run-status taxonomy (completed / agent error / harness error / simulator untrustworthy) so a harness bug is never counted as an agent failure. This project found several: the call cut short before a scripted emergency, the 400-token reply limit, and leaks through personas.

## 11. From finding to owned work

- Each recurring failure pattern becomes a ticket with an **owner, a metric, and a scenario** added to the suite as its regression test. For example, "false commitments" is owned by agent engineering: metric = false commitments per 1,000 calls, gate = 0 on the suite.
- **Rubric and answer-key issues go to a pharmacy or clinical owner, not engineering.** The S04, S21 and S03/S08 fixes in this project were practice decisions, made by the person with the domain knowledge.
- A weekly review of the top failure patterns, the calibration numbers, and anything the random sample found that the suite doesn't cover yet.

## Boundaries: what I would not build first

- A dashboard of overall pass rates.
- Auto-generated rubrics without human review.
- An LLM judge on every call.
- Using any model's grades before it has been calibrated against human labels.
