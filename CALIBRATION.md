# Part 3: Can the evaluator be trusted?

The evaluator has three parts: code checks on the records (required outcomes), an LLM judge on the conversation (caller handling), and a hybrid for claims (the LLM finds what the agent said was done; code checks whether it was true at that moment). See [EVALUATOR.md](EVALUATOR.md).

To see how far to trust it, I reviewed its output as a pharmacy technician would.

## Method

- **Sample:** 16 calls from `baseline-v1` (agent v1). They cover both workflows (12 pharmacy, 4 clinic) and a mix of results: the evaluator had passed 7 and failed 9.
- **Labels:** in the app, I marked each finding Pass or Fail where I had a view, plus my overall verdict on the call, with a note whenever I disagreed. There were **168 finding labels and 16 call verdicts**, saved in [`labels/labels.json`](labels/labels.json).
- **Measure:** agreement and Cohen's κ between the evaluator and my labels, split by evaluator part, and the direction of each disagreement. This is the app's **Review & calibration** page.

## Results

| Evaluator part | Labelled | Agreement | κ | Too lenient | Too strict |
|---|---|---|---|---|---|
| Caller handling (LLM judge) | 81 | **100%** | 1.00 | 0 | 0 |
| Required outcomes (code) | 64 | 97% | 0.78 | 0 | 2 |
| Claims (LLM finds, code checks) | 23 | 91% | 0.45 | 1 | 1 |
| **Overall call verdict** | 16 | **63%** | **0.21** | 4 | 2 |
| All findings | 168 | 98% | 0.86 | 1 | 3 |

**The evaluator agrees with me on the details, but not on whether a call passed.** On individual findings it is almost always right. On the verdict for the whole call it matched me only 10 times out of 16.

## Why the call verdicts disagree

1. **My standards include things the answer key never checks; the evaluator was too lenient on 4 calls.**
   - A02: asking for a phone number when name and DOB were enough.
   - A04: announcing that Walt is an authorized contact.
   - S02: saying "let me verify your identity" out loud.
   - S21: not mentioning that a C-II can only be transferred once.

   Every check passed, but I would fail the call. These are **rubric gaps**, not grading errors.
2. **I judge the whole call; the evaluator fails a call on any single miss. It was too strict on 2 calls** (S19, S20), where one minor miss wouldn't make me fail the call.
3. **Some answer-key items were wrong by my own standards:**
   - **S11:** it penalised "the Main St store will have it ready". The agent represents that store, and it's the patient's home store.
   - **S11:** it required a transfer when the caller couldn't identify the old pharmacy.
   - **A03:** it required the agent to ask "which Friday?" when Jamal had already said October 2nd.

## What changed because of this review

- **Answer keys fixed (dataset 2.1.1):**
  - **home store = default store** (S03, S08; found reviewing S08);
  - the agent **may say the medication will be ready at the patient's own Harbor home store**, but never at another pharmacy, a store they're only visiting, or for a prescription that doesn't exist yet (S06, S08, S11, S12);
  - **S04** no longer requires announcing an authorized contact.
- **A simulator bug found:** in S21 the call ended before the emergency the scenario tests ever came up, so the agent was graded on a situation it never saw. The simulator now waits for guaranteed scripted moments, and a run where one never happens is marked invalid (director 1.1.0).
- **Agent v2's rules** (Part 5) include two taken directly from my notes: don't over-ask for ID, and don't announce authorization.

## Re-running after the revision (did it help?)

After the answer-key revisions (dataset 2.1.1), I re-graded the same 16 calls and measured agreement again (`npx tsx scripts/calibration_rerun.ts`). The re-graded copies and `report.json` are in `research/calibration-rerun/`; the original grades are untouched.

| | Before revision | After revision |
|---|---|---|
| Findings | 98% (164/168) | 98% (163/166) |
| Call verdicts | 63% (10/16) | **63% (10/16)** |

**The revision didn't move call-level agreement at all**, and that's the useful result:

- **The call-level disagreements were never about wrong answer keys.** They come from standards that aren't in the rubric at all (over-asking for ID, narrating verification, announcing authorization, the C-II transfer rule) and from the all-or-nothing verdict. Fixing keys can't touch either.
- **The real fix is structural:**
  1. add those standards as checks that run on *every* call, as "house rules" rather than per-scenario items;
  2. make the call verdict severity-weighted, so a minor miss doesn't fail a call a pharmacist would pass.
- **My own labels contradicted each other on S11.** I marked the claim "the Main St store will have it ready" as fine, and the matching behavior check, the same statement, as a failure. The rule wasn't settled when I labelled; I settled it afterwards (dataset 2.1.1). Agreement numbers can't be better than the consistency of the labels they're measured against.

## How far to trust each part

- **Caller-handling judge: trust it** on the behaviors the answer key names (81/81). It can't catch what the rubric doesn't ask about.
- **Required-outcome checks: trust them.** They're code. Their disagreements with me were answer-key errors, not code errors.
- **Claims: mostly trust them.** κ is lower because there are few claims to label (23), so single disagreements move it a lot.
- **Overall pass/fail: don't use it as a headline.** It's all-or-nothing and inherits every rubric gap. In Part 5, fixing two answer-key flaws flipped the experiment from "v2 is worse" to "v2 is slightly better". Report required outcomes, specific safety behaviors and false claims instead.

## Limits of this calibration

- **One reviewer:** these are my standards. A second pharmacy reviewer would show how much of the disagreement is me and how much is the rubric.
- **The judge shares a model with the simulated caller** (Claude Sonnet 5), so they could share blind spots. This review is the check on that.
- **The judge isn't deterministic.** Sonnet 5 doesn't accept a temperature setting, so a re-judged call can come out differently. Every judgment is cached, so a saved result always replays identically.
- **16 calls:** enough to see the pattern, not to pin down κ precisely. Item-level numbers (168 labels) are much steadier than call-level ones (16).
- **Where the raw evidence is:** the labels are in `labels/labels.json`; every evaluator output (verdict, reason, cited turn) is in each call's `.eval.json`; every raw judge response is in `llm-cache/`; disagreements are on the app's Review & calibration page.
