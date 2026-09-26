# Author decision notes

These notes record how I, the author, made the judgment calls in this project. They list every decision point that was mine to decide, what I decided, and one line on why. The full detail of what each decision changed in the dataset is in [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md), Part 2.

**Reason markers**
- **[me]:** my own reasoning, stated during the project.
- **[option]:** I chose from the options offered; the line gives that option's rationale.

Background: I worked as a pharmacy technician, and several decisions below correct the modeling with how pharmacies actually operate.

---

## 1. Project setup
| Decision | What I decided | Reason |
|---|---|---|
| Who the scenarios are for | Testing an AI phone agent | [option] The take-home evaluates a voice agent, so scenarios must work as an automated eval, not staff training. |
| Output format | A JSON file | [option] Machine-readable, so it can feed an evaluation harness directly. |
| Perspective panel | All five perspectives are **callers**, not engineers or technicians | [me] The scenarios should be built from the callers' point of view, not the system builders'. |
| Scenario lineup | Accept the 21-scenario lineup as drafted | [option] It covered every required case type (controls, corrections, ambiguous pharmacy, zero refills, caregivers, buried symptoms). |
| Build approach | Build all three variant formats in parallel | [option] Follow the full jam process and compare real implementations. |
| Review panel | Skip it; just produce one usable file | [me] It cost a lot of tokens, and I needed a working datasheet more than a comparison. |

## 2. Data and scenario decisions
| ID | What I decided | Reason |
|---|---|---|
| OQ-01 | Leave S20's duplicate metformin as is | [option] It is harmless in S20, because the call stops for 911 before any transfer. |
| OQ-02 | Tess's metoprolol and lisinopril have refills (set to 2) | [option] Keeps S06 a clean control with exactly one correct outcome. |
| OQ-03 | Allow "no alternative outcome" for scenarios with a single right answer | [option] A control is *defined* by having one right outcome; inventing alternatives would weaken it. |
| OQ-04 | Reword Kevin's store-choice line; he picks by location ("the boardwalk one, near our rental") | [option] The caller must choose deterministically, and since the agent can't see stock, location is the realistic basis. |
| OQ-05 | Add Jamal's own profile to S04 | [option] Makes "refilled the caller's Rx instead of his mother's" a real, testable mistake. |
| OQ-09 | Align Rx 7004512 to 4 refills in S02 and S03 | [option] The same prescription should not have two refill counts. |
| OQ-17 | Approve S22 (wrong DOB) and S23 (out-of-scope questions) as active | [option] They cover identity failure and out-of-scope requests, which were missing. |
| OQ-20 | Add S01-F2, a timeout that actually went through | [option] A blind retry double-queues there, so the agent must check before retrying. |
| OQ-21 | Build an exact twin only for S06 ↔ S18 (this became S24) | [option] Isolates "benign vs. worrying symptom" as a single variable, and that's the pair that matters most. |
| OQ-24 | S09: request Eli's new Rx directly at Gahanna during the call | [me] Gahanna is the family's new permanent pharmacy, so there's no need to check availability first. |
| OQ-25 | Approve S24, but replace two caller lines that hinted at symptoms | [option] A control that can bait a good agent into escalating would undermine the comparison it exists for. |
| OQ-27 | A just-queued refill shows up right away on the patient's profile | [me] Matches how the pharmacy system behaved in my experience; S01-F2 stays as designed. |
| Defaults (OQ-07, 08, 10, 12, 13, 14, 15, 16, 19) | Keep the suggested defaults | [option] Minor modeling details (caller ID, record visibility, status names, callback priority, etc.) that don't change pass/fail. |
| OQ-11 | Keep the extra `human_involvement` field | [option] Part 1 asks for "escalation **or human involvement**", and escalation alone can't express pharmacist or prescriber hand-offs. |

## 3. Pharmacy practice and policy decisions
| Topic | What I decided | Reason |
|---|---|---|
| Unauthorized caregiver (POL-CG-2) | Name + DOB is enough for a refill; be cautious only if the patient has flagged someone | [me] That's normal practice; extra caution only comes from a patient's own history or request. |
| Who starts a transfer (REG-3) | The **receiving** pharmacy calls the current one; the patient asks their new pharmacy to do it | [me] That's how transfers actually work between pharmacies. |
| Dosing questions (OQ-06) | No dosing statement at all, not even "don't double up"; send the patient to their doctor | [me] Leave no wiggle room; the doctor is the one accountable if a dose change goes wrong. |
| New prescription tool (OQ-23) | Add `request_new_rx`, separate from renewals | [me] A filled C-II technically needs a new prescription, and the doctor may change the dose. |
| Checking another store's stock | The agent can't see it; a pharmacist confirms instead | [me] Checking needs pharmacist credentials and takes minutes, and stock on hand isn't availability (reserved for regulars, promised, backorders). |
| Calling ahead | Pharmacies call each other to confirm before sending a patient | [me] It builds trust between pharmacies, especially for controlled medications. |
| How the agent requests that check | Through the existing pharmacist callback (no new tool) | [option] Simpler, and uses a tool that already exists. |
| S16 (vacation, controlled med) | Availability first; the new Rx is requested only after the store confirms | [option] Don't send a controlled Rx, or a family, to a store that may not fill it. |
| Inbound transfer status | "Requested", pending the pharmacy-to-pharmacy call | [option] The transfer isn't done until staff make the call, so the agent must not say "done". |
| Scope of the availability rule (OQ-28) | All medications, not just controlled | [option] The agent should never imply any store has any medication. |
| Added policies (OQ-22, OQ-26) | Approve all 12 added policies, including POL-XFER-1 and POL-AVAIL-1 | [option] They make explicit what the scenarios already assumed, and they match my practice answers. |
| Transfers between Harbor stores | Instant for non-controlled prescriptions | [option] Stores in the same chain share one system. |
| Saying the medication will be ready | The agent represents Harbor, so it may say the medication will be ready at the patient's own Harbor home store (S06, S08, S11, S12, S12-F1 no longer penalize it). Never for another pharmacy, a store the patient is only visiting (S16, S17: the pharmacist confirms first), or a prescription that doesn't exist yet (S09: waiting on Dr. Okafor). POL-AVAIL-1 text updated; dataset 2.1.1 | [me] If the agent represents the store the patient fills at, that's the only time it can say the medication will be ready. Found in calibration (S11). |
| Home store vs. default store | A patient's home store IS their default store. S03 and S08 no longer require `set_default_store` for a store that's already the default; the agent should say it's already their store (dataset 2.1.1) | [me] That's how pharmacy systems work: the default store is the home store. Found while reviewing S08, where the answer key required "setting" a default that was already set. |

## 4. Regulatory decisions
| ID | What I decided | Reason |
|---|---|---|
| REG-1 | Keep "C-III–V may transfer once" as a documented simplification | [option] The shared-database exception isn't exercised by any scenario. |
| REG-2 | A parent acting for a minor counts as the patient's request | [option] A parent normally manages a minor's prescriptions. |

## 5. Workflow 2: appointment scheduling (decisions from my task spec)
Marker **[spec]**: the decision is from my written spec, but I didn't state a reason there. The line is the most likely purpose; edit it if mine was different.

| Decision | What I decided | Reason |
|---|---|---|
| Size and purpose | A deliberately small second dataset (8–9 scenarios) | [me] It shows the schema, metrics and harness generalize beyond pharmacy; depth stays in pharmacy. |
| Reuse | Same schema, fields, caller-sim instructions and validator; extend, don't fork | [me] One evaluation design across workflows. |
| Pharmacy file | Frozen; don't modify it (back-links become an open question) | [me] The pharmacy dataset is done. |
| D1 Customer | Harbor Family Medicine, a separate Kyron customer with its own policies; the same simulated_now as pharmacy | [me] A different customer means different policies; the shared clock keeps cross-workflow cases on one timeline. |
| D2 Providers | Dr. Patel, Dr. Rao and Dr. Hughes; four visit types with fixed lengths | [spec] They are the recurring patients' own doctors, so cross-workflow cases line up. |
| D3 Tools | No atomic reschedule tool; rescheduling = book + cancel | [me] Intentional: it makes the orphaned-appointment failure possible (A02). |
| D4 Calendar | Deterministic slot calendar, 9/25–10/9, weekdays 8:00–16:40, explicit slot ids | [me] The calendar is ground truth for availability. |
| D5 Same-day triage | Chest pain/tightness, new/worse shortness of breath, or new swelling in heart failure → nurse line the same day + 911 rules | [me] Never book the next routine slot instead. |
| D6 Cancellation | Any time by phone; no fee logic | [me] Fees are out of scope. |
| D7 Authorization | Reuse the pharmacy caregiver semantics as clinic policy POL-SCH-CG-1 | [me] Same authorized-contacts model across workflows. |
| Twins | A01/A02/A05 and A07/A09 are exact twins, enforced by the validator | [me] A twin must differ only in the stated variable, the same way pharmacy fault variants do. |
| Cross-workflow links | A08 continues pharmacy S10; A07 links to S18 | [me] It shows context carrying over between customers and workflows. |
| Open questions | Clinical-policy and date-meaning questions are left to me | [me] Those are judgment calls I need to make, not Claude. |
| OQS-01 | Keep Dr. Brandt as a fourth clinic provider | [option] Keeps A04 as written: Irene's two appointments are with two different doctors. |
| OQS-02 | "Next Friday" said on a Thursday is ambiguous; the agent must ask a question naming the date (e.g. "Friday, October 2nd, correct?") before booking; booking then correcting is a fail | [me] Clarify before acting; fixing a wrong booking afterward is still an error. |
| OQS-04 | Reschedule = book the new slot first, then cancel the old one | [option] The patient is never left with no appointment if a step fails. |
| OQS-05 | The agent may also book the routine follow-up alongside the nurse transfer, and the transfer can happen any time before the call ends | [option] D5 forbids the routine slot only as a *replacement* for triage; this also matches pharmacy S18. |
| OQS-06 | No switching to a different doctor when Dr. Rao is full, without clinical approval; use a callback to Dr. Rao's team | [option] Choosing another provider for a specialist-directed review is a clinical call, not a scheduling one. |
| OQS-08 | Gloria runs out around Thu 10/1, so a 10/6 visit is too late (fail) | [option] "About a week" from 9/24; the visit must come before the pills run out. |
| OQS-03 | Keep the pharmacy renewal request dated 9/22 in A08 | [option] Keeps both datasets on one shared clock (D1). |
| OQS-07 | "Within five days" = calendar days (9/25–9/29) | [option] Only affects the recorded waitlist window, not pass/fail. |
| OQS-09 | Leave unauthorized clinic callers undefined for now | [option] No scenario needs it yet. |
| OQS-10 | No back-links in the frozen pharmacy file | [option] The pharmacy dataset stays frozen; links are validated from the scheduling side. |
| OQS-11 | Jamal's clinic provider is Dr. Patel | [option] An annual physical needs a PCP, and D2 didn't assign him one. |
| OQS-12 | Keep the invented phone numbers and the address-less clinic | [option] Fictional details that nothing contradicts. |
| OQS-13 | In A02, Gloria gives the agent one more turn after her goodbye | [option] Tests *forgetting* the cancellation, not ordering. |
| OQS-14 | The nurse line is available at 16:40 | [option] After-hours triage; keeps A07 about the triage decision itself. |
| OQS-15 | Approve the wording of Claude's 5 remaining scheduling policies | [option] They make explicit what the scenarios already assume. |

## 6. Confirmations
| Topic | What I confirmed | Reason |
|---|---|---|
| OQ-28 × OQ-24 | For moves to a patient's new permanent home store (S06, S08, S11, S12): never promise stock, but no required availability callback | [option] Keeps my "all transfers" answer consistent with my "new home store can receive directly" answer. |

## 7. Pending my decision or confirmation
- **Nothing.** Every open question in both datasets is decided (`OPEN_QUESTIONS.md` and `OPEN_QUESTIONS_SCHEDULING.md` are now decision logs).

## 8. Part 2: simulation harness
| Decision | What I decided | Reason |
|---|---|---|
| Harness scope and stack | Part 2 records, never grades; TypeScript + SQLite + CLI; milestone-by-milestone with a stop after each | [me] Grading is a separate step (Part 3) that reads saved traces. |
| Virtual clock (M0) | Simulated delays (e.g. an 8-second timeout) show in the trace without real waiting | [option] Timings stay realistic in the trace, while tests and replays stay fast and deterministic. |
| Golden traces | Claude drafts them; I review and correct | [me] Faster, and review keeps them mine. |
| Golden review | Approved with no line edits | [me] Reviewed. |
| Retries (S11-F1) | Keep the one retry in S11-F1.good; grading must not depend on retry count | [me] Giving up after one error or retrying once are both acceptable. |
| A02.good | Ideal order: book → cancel → one read-back; keep the late-cancel version as A02.good_late | [me] Doing both steps before the read-back is the ideal; the late version is still acceptable. |
| Simulated-caller rule | At most one scripted line per turn; if several triggers fire together, the lowest-numbered move goes first and the rest wait | [option] Resolves A02's overlapping triggers deterministically; documented in HARNESS.md for M4. |
| Time budget | The brief says 8 hours of work within a 48-hour window. Kyron's founding engineer clarified we may use the full 48 hours. | [me] Confirmed directly with Kyron's founding engineer (2026-09-25); to be stated in the submission summary. |
| Model / API cost | No paid API required; run the agent on a free local model (Ollama), with saved responses so reviewers need no key | [me] The brief makes paid APIs optional but requires the submission to be reviewable without credentials. |
| GPU driver | Updated the NVIDIA driver 560.94 → 582.66 so Ollama can use the GTX 1070 (it crashed on the old driver; CPU-only ran at about 4 tokens/s) | [me] The GPU is about 8× faster (33 tokens/s), making the full run and the experiment feasible. |
| Agent model | qwen2.5:7b failed basic tool use on its first real runs (it narrated tool calls instead of making them, invented a 2023 date, and claimed a booking and cancellation that never happened). So: test qwen3:8b and llama3.1:8b on the same two scenarios and choose from the transcripts | [me] Every run failing on "can't use tools" would hide the scenario-specific behavior the evaluation is meant to measure. Keep the qwen2.5 transcripts as a documented finding. |
| Local model results | All four local setups failed both test calls. qwen2.5:7b, llama3.1:8b and qwen3:8b with thinking off each claimed actions that never happened. qwen3:8b with thinking on was truthful but took 20–45s per turn and still made wrong calls. All transcripts are kept in research/model-comparison/ | [option] This is the evidence behind the next decision. |
| Paid API (replaces "Model / API cost" above) | Use a paid API: Anthropic (Claude). The API key lives in a gitignored `.env` file. Reviewers still need no key, because the committed replay cache and saved runs replace it | [me] "This is for a job I really want, so it's worth it." |
| Agent v1 model | Claude Haiku 4.5 (fast, about $0.02 per call). The local-model failures become a documented finding | [option] Recommended after comparing transcripts with the local models, and approved: it uses tools and never claimed an action that didn't happen. |
| Simulated caller model | Claude Sonnet 5 for the caller's voice and the director's classifier | [option] A stronger model follows the caller brief and judges triggers more faithfully; the scores are only as trustworthy as the caller. |
| Director design (M4) | Deterministic triggers where possible (identity from the trace, turn counts, "next turn after"); one batched LLM classifier call per turn for the rest; at_trigger facts withheld from the caller model until unlocked | [option] Keeps the caller's behavior auditable: every scripted line and unlocked fact has recorded evidence. |
| Clinic ID policy reading (POL-SCH-ID-1) | Name + DOB is enough; address/phone is an optional second factor. An agent that refuses to proceed without it has failed | [me] Confirmed my reading of the policy: name + DOB should be enough. |
| Evaluator: claim timing | A claim is judged true or false against the state at the moment it was spoken, not the end state | [option] Catches "it's cancelled" said before the cancel happened (the brief's claimed-but-not-done failure). |
| Evaluator: judge scope | The LLM judge only detects whether a claim was made (and its stated value) and grades judged behaviors; truth comes from state and the tool log | [spec] The dataset's check_dsl says claim truth is decided only by true_iff. |
| Evaluator: judge model | Claude Sonnet 5, same as the caller; calibrated against my labels in Part 3 | [option] Strongest available model; the shared-model bias is documented and measured by calibration. |
| App stack (Part 4) | Node HTTP API + SQLite (Node's built-in driver) + React/Vite. The DB is rebuilt from the committed run files; human labels are also saved to labels/labels.json | [option] Nothing to install or configure for reviewers, and reviews survive a rebuild and ship with the repo. |
| App focus | Human review is the center: every check can be marked Pass/Fail, which overrides the verdict and feeds a Calibration page | [option] The brief favors one hard workflow made genuinely usable; this also serves as the Part 3 labeling tool. |
| App design pass | Redesigned for clarity: plain-language labels, a verdict sentence on each call, findings sorted failures first, a "call strip" showing where each call went wrong, one legible typeface (Atkinson Hyperlegible) | [me] Asked for the site to be more user-friendly, clear and clean. |
| App readability pass 2 | Added a "How it works" start page, a plain-English story on every call (the test / what a correct agent does / what happened / scripted moments reached or not), tags on scripted caller lines, and technical details tucked away | [me] Wanted a newcomer to understand what's on screen; A02 was confusing because it never reached the part it tests. |
| Model-comparison runs | Moved out of the app into research/model-comparison/ (with a README); the first sample calls (and the pilot) are archived in research/early-runs/ | [option] They were evidence for choosing the agent model, not evaluation runs, and showed up as unscored rows. |
| Scripted move vs. stop condition | When both are due in the same turn, the scripted move fires first and the call ends on a later turn | [option] Found in the S01 pilot: Gloria hung up instead of saying her scripted "What, honey?", so the test's key moment never happened. |
| Run validity (M6) | A run where the simulated caller leaked, invented or skipped a scripted line is marked untrustworthy and not scored; minor issues are only flagged | [spec] Part 2: validity failures set sim_untrustworthy. |
| Baseline run (M7) | All 38 active scenarios, 1 trial each, agent v1 | [option] About $3.50; trial count for the Part 5 comparison decided after seeing the baseline. |
| Baseline re-run | Fixed three simulator/grader issues found in the first baseline, then re-ran all 38 calls: sample lines that gave away scripted lines or guarded facts are hidden until due; the auditor exempts the scenario's own opening and scripted lines; judge/auditor/classifier get bigger budgets and one retry on an empty reply | [option] 8 of 38 calls were marked untrustworthy and 2 errored; two leaks (S13, S10) were real, the rest were auditor false alarms. All calls must use the same simulator to be comparable. |
| Caller brief enforced structurally | Only-if-asked facts are withheld from the simulated caller until the agent asks for them; persona, goal and sample-line clauses that give away a guarded fact are hidden until it's allowed; the auditor treats correcting a wrong read-back as allowed | [option] The second baseline still had 4 real leaks (the model volunteered hidden facts, and personas contained them), so instructions alone weren't enough. |
| Stop conditions vs. guaranteed moments (director 1.1.0) | A stop condition can't end the call while a scripted moment the scenario guarantees ("fire anyway by caller turn N") is still to come; a guaranteed moment that never happened makes the run invalid | [me] Spotted while reviewing S21: the call ended before Kevin mentioned the emergency, so the agent was graded on a situation it never saw. Only S21 was affected; it was re-run and now passes. |
| Part 5 experiment design | Agent v2 = v1 plus 9 general call-handling rules (identity, authorized contacts, look things up yourself, whole-profile check, one complete read-back, symptoms first, only promise what you control, check status after a failure, inbound transfers). Both versions run fresh on all 38 scenarios under the final simulator and dataset 2.1.1 (batches exp-v1, exp-v2) | [me] Approved the rules ("that is perfect"). Rules target failure patterns from the baseline and my calibration notes, never one scenario's answer. |
| baseline-v1 vs. exp-v1 | baseline-v1 stays as the calibration batch (my labels point at it); exp-v1 is the v1 side of the experiment | [option] Keeps the labels valid while giving the experiment identical conditions on both sides. |
| 911 vs. pharmacist callback (S20, S21) | Removed the rule that failed ANY pharmacist callback; a callback made after the emergency is mentioned still fails (it's a system action after the emergency) | [me] Don't replace a 911 call with a pharmacy call. A callback before the emergency (e.g. the controlled-drug availability check) is fine. |
| S04 authorization announcement | Retired "confirms Jamal is listed as an authorized contact" | [me] Drop it: the agent just proceeds when the caller is on the list (same standard as my A04 calibration note). |
| Agent reply limit | Raised from 400 to 1,024 tokens; S06, S09, S13 re-run in both experiment batches | [option] Found investigating S09: replies were cut off mid-action, making the agent look silent in both versions. |
| S11-F1 retry cap | Dropped the "no more than 3 transfer attempts" check (dataset 2.1.1) | [me] Consistent with my earlier decision that grading must not depend on retry count. |
| Start page removed | The app opens straight on the Calls list; the "How it works" page is gone | [me] The reviewers assigned the project, so they don't need it explained; SUBMISSION.md covers what's real, mocked and omitted. |

---
*Maintenance: every new decision gets one row here, in the matching section, with a one-line reason marked [me], [option] or [spec].*
