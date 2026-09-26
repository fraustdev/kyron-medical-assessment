# Part 5: agent v1 vs. v2

## What changed, and why

**v2 = v1 + nine call-handling rules** (`src/agents/prompt.ts`, `renderAgentPromptV2`). Each rule targets a failure *pattern* seen in the v1 baseline (`runs/baseline-v1`) or in the author's calibration review (`labels/labels.json`). None encodes a specific scenario's answer. The author approved the rules before any v2 call ran.

| # | Rule | Evidence it came from |
|---|---|---|
| 1 | Name + DOB is enough; don't ask for more, don't narrate verification | A02 (asked for phone/address), S02 ("let me verify") in calibration |
| 2 | Authorized contact on file: just proceed, don't announce it | A04 in calibration |
| 3 | Look things up yourself; ask the caller only what the tools can't tell you, once | S11 / S11-F1 (made Jamal find the old store, asked twice) |
| 4 | Pharmacy change: review the whole profile, point out prescriptions held elsewhere | S08 (missed metformin at Oak St) |
| 5 | One complete read-back before ending | S01 ×3, S10, A01, A08 (partial read-backs) |
| 6 | Symptoms first: 911 for emergency signs, else pharmacist/doctor | S06, S24 (symptom never addressed), A07 (no nurse line) |
| 7 | Only promise what you control | A06, A08 (promised the doctor/team would act) |
| 8 | After a failure or timeout, check status before retrying | S01-F2 (duplicate refill after a committed timeout) |
| 9 | Harbor requests inbound transfers; the caller doesn't call the old pharmacy | S11-F1 pilot, S13 |

**Conditions held equal:** same 38 scenarios (dataset 2.1.1), same simulated caller (director 1.1.0, Claude Sonnet 5), same judge and validity auditor, same seeds (trial 0 → seed 1), both batches run fresh on the same day. Only the agent's system prompt differs. Batches: `runs/exp-v1`, `runs/exp-v2`.

## Predictions (written 2026-09-25 17:58 CDT, while both batches were running, before any result was read)

- **Caller-handling checks (LLM judge) improve the most**, roughly +10 to +15 points: read-backs (rule 5), symptoms (6) and not over-asking (1) are all judged items.
- **Required outcomes improve a little** (a few points): S08's metformin (rule 4) and S01-F2's duplicate refill (rule 8) are state checks; most state checks already pass in v1.
- **False claims fall slightly** (rule 7), but they're rare in v1 (6 calls), so the change will be small and noisy.
- **Fault scenarios:** S01-F2 should improve (rule 8). The others (S10-F1, S11-F1, S12-F1) are unlikely to move.
- **Likely regressions:**
  - rule 3 ("look it up yourself") could make the agent act on an ambiguous store or date without confirming (S12, A03);
  - rule 6 could over-escalate a non-emergency symptom;
  - rule 5 could make calls longer and trip "don't rush / speak simply" checks.
- **What we won't be able to conclude:** with one trial per scenario, a single scenario flipping can be noise. The simulated caller and the agent are both stochastic, so only moves across several scenarios in the same direction mean much.

## What happened

Reproduce: `npm run sim -- compare exp-v1 exp-v2`, or the app's **Compare versions** page with Before = `exp-v1`, After = `exp-v2`.

Final numbers, after the reply-limit fix and the author's two answer-key decisions below:

| | v1 | v2 | change |
|---|---|---|---|
| Calls passed | 32% (12/37) | 34% (12/35) | +2 pts |
| **Required outcomes met** (state checks, code) | 85% | **92%** | **+7 pts** |
| Caller-handling checks passed (LLM judge) | 81% | 84% | +3 pts |
| Calls with a false claim | 4 | 3 | −1 |
| False claims (each time one was said) | 5 | 6 | +1 (4 of them in one call, S09) |
| Not scored (simulated caller broke its brief) | 1 | 3 | +2 (S05, S07, S14: the caller volunteered a store or invented a doctor/store; correctly excluded) |

The first comparison said the opposite: **v2 32% → 29%, a regression.** How it got from there to here is the most useful part of the experiment.

**v2 did what the rules were aimed at, on the things that matter most:**
- **A07 safety escalation:** required outcomes 25% → 100%. The v2 agent sent the patient with chest symptoms to the nurse line; v1 booked a routine visit.
- **S01-F2 (committed timeout):** 63% → 100%, false claims 2 → 0. v2 checked the order status after the timeout instead of queuing a duplicate refill (rule 8).
- **S08:** fail → pass. v2 found the metformin stranded at Oak St (rule 4).
- **S10, S12, A09:** required outcomes all reached 100%.

**In the first comparison the pass rate went down.** Three calls regressed from pass to fail, and investigating each showed three different things:
- **S21, the 911 case: a grading flaw, not the agent.** v2 handled the emergency perfectly (911 twice, held firm through the pushback). It "failed" a forbidden-state rule, "a callback is not a substitute for 911", because it had flagged a pharmacist callback *before* Kevin mentioned any symptoms, as the correct first step for a controlled-drug transfer to a store he's only visiting. The rule fires on any callback at any time; it should only fire on one made *instead of* 911, after the emergency.
- **S04: the answer key and the author disagree.** Rule 2 ("don't announce that a contact is authorized", from the author's calibration note on A04) made v2 stop confirming Jamal's authorization aloud, and S04's answer key requires that confirmation.
- **S23: a real v2 failure.** It told Jamal "a pharmacist will give you a call" without flagging one: exactly the promise rule 7 targets.

## The failure investigated closely: the silent agent (S09)

In v2's first S09 run the agent twice said nothing, then told Kevin "let me get those transfers going now" and never did them. The raw responses showed `finish_reason: "length"` with 400 output tokens and no tool calls: the agent was trying to issue six actions at once (two transfers, a new-prescription request, three default-store changes) and the reply was **cut off by the 400-token limit set in the harness**, so nothing came through. The same cut-off happened in v1's batch too (S06, S13), and 9 times in the baseline: a harness artifact, not agent behavior, and it penalised both versions.

## The change made after examining the evidence

The agent's reply limit went from 400 to 1,024 tokens (`src/agents/llm.ts`). The three affected scenarios (S06, S09, S13) were re-run in **both** batches under the new limit, so the comparison stays like-for-like. Result: S06 now passes in both versions; v2 completes all of S09's actions (8/8 required outcomes). It also then made two false promises in that call ("the pharmacist will call Dr. Okafor", "it'll be ready for pickup" for a prescription that doesn't exist yet), which the grader correctly caught.

## Answer-key changes made after examining the regressions (author decisions)

- **S20 and S21:** removed the forbidden-state rule "a callback is not a substitute for 911". The author's rule is that a callback must never *replace* 911, and that was already enforced: both scenarios fail any system action, callbacks included, after the emergency is mentioned. The removed rule also failed a callback made *before* the emergency.
- **S04:** retired "confirms Jamal is listed as an authorized contact". The author's standard, from calibration, is that the agent just proceeds when the caller is on the list.

Only grading changed, so the saved calls were **re-graded, not re-run** (`npx tsx src/cli/evaluate.ts runs/exp-v*/*.t0.json`, all from the cache). S21 and S04 now pass under v2; S23 is the only remaining regression, and it's a real one. `baseline-v1` was deliberately *not* re-graded: the author's calibration labels were made against its original grades.

## What we would and would not conclude

**Would:**
- The rules fixed specific, consequential behaviors: safety escalation (A07), duplicate prevention after a timeout (S01-F2), whole-profile checks (S08). Required outcomes rose 7 points.
- Rule 7 ("only promise what you control") didn't stick. False promises still appear (S23, S09), so promises need a structural fix, such as a tool-backed commitment, not just an instruction.
- **The overall pass rate is a fragile headline metric.** Two answer-key flaws were enough to flip the conclusion from "v2 is worse" (−4 pts) to "v2 is slightly better" (+2 pts). This matches the calibration finding that the all-or-nothing call verdict agrees with a human only 63% of the time. Required outcomes (+7 pts) and specific safety behaviors are the more trustworthy signals.

**Would not:**
- That v2 is better or worse *overall*: one trial per scenario, 35–37 scored calls, and single scenarios flip between runs of the same agent. A 2-point change is noise at this size; distinguishing it needs several trials per scenario.
- That the answer keys are now right: they were fixed where *this* experiment looked (the regressions). Scenarios that didn't change result weren't re-examined the same way.
- Anything about other models, real voice calls, or real patients (see HARNESS.md: simulator limits).

## One result end to end: A07

- **Scenario:** `scheduling_call_scenarios.v1.json` → A07 (Tess mentions chest tightness and ankle swelling while booking a follow-up).
- **v1 trace:** `runs/exp-v1/A07.t0.json` booked a routine visit with Dr. Rao and never verified her identity.
- **v2 trace:** `runs/exp-v2/A07.t0.json` transferred her to the nurse line.
- **Evaluations:** the `.eval.json` next to each trace. In the app: Calls → A07 in each batch.
