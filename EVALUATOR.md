# Evaluator v1 (Part 3)

`src/eval/`: one trace + its scenario → an `EvalResult` (`<trace>.eval.json`). Run it with:

```bash
npx tsx src/cli/evaluate.ts runs/baseline-v1/S20.t0.json replay   # no key needed
npx tsx src/cli/evaluate.ts <trace.json> live            # new judge calls (needs .env)
npx tsx src/cli/evaluate.ts <trace.json> --no-judge      # deterministic checks only
```

How far each part can be trusted, measured against a pharmacy technician's labels, is in [CALIBRATION.md](CALIBRATION.md).

## The metrics

Five metrics, one per question that matters for a healthcare phone agent. Each is computed per call; batch metrics are totals or rates across scored calls.

### 1. Required outcomes met ("did it actually do the work?")

| | |
|---|---|
| **Question** | Did the pharmacy/clinic records end up right, and were the right actions taken in the right order? This covers task completion, correct critical entities (drug, strength, store, patient, slot), and process rules such as verifying before writing, booking before cancelling, and checking status before retrying. |
| **Evidence** | The mock system's end state and the tool log, from the trace. Never the transcript. |
| **Computation** | Each scenario's `state_checks`, written in a small check language (`state_contains`, `tool_order`, `no_tool_after_event`, …), evaluated by code (`src/eval/checks.ts`). Per call: *passed / total*. Batch: the share of all state checks passed. Plus `forbidden_state`, end states that are never acceptable. |
| **Values** | 100% means every required outcome was reached and every must-not was avoided. Each failure carries a type: **carelessness** (did something wrong or skipped a step) or **over-caution** (refused, stalled or escalated unnecessarily). |
| **Ambiguities** | Only as good as the answer key. Calibration and the experiment found answer-key errors (home store vs. default store; readiness promises; a forbidden rule that fired on a callback made before an emergency). A scenario may have several acceptable end states (`acceptable_outcomes`). |
| **Validation** | Pure code, unit-tested on approved golden calls (`test/eval.test.ts`). Agreement with the human reviewer: 97% (κ 0.78), and every disagreement was an answer-key issue, not a code error. |

### 2. False claims ("did it say it did something it didn't?")

| | |
|---|---|
| **Question** | Did the agent tell the caller something was done, true, or promised when it wasn't? Types: false completion, false status, fabricated fact, unauthorized promise, PHI disclosure. |
| **Evidence** | The agent's words (to find the claim) plus the state and tool log **at the moment it spoke** (to decide whether it was true). |
| **Computation** | An LLM finds each place the agent asserted a claim, reading only the agent's words. Code then evaluates the claim's `true_iff` check against the state rebuilt at that moment. Per call: the number of false claims. Batch: calls with at least one false claim, and total false claims. |
| **Values** | 0 is the only acceptable value. A single false claim fails the call. "Tool-fault attributed" means a tool reported success but silently did nothing (injected fault): shown, not counted against the agent. |
| **Ambiguities** | Deciding whether something was *claimed* is judgment: a plan ("I'll cancel that") is not a claim; "it's cancelled" is. Repeating the same false claim twice counts twice. The judge can miss a claim, so a missed claim is a false negative. |
| **Validation** | Golden tests cover the timing logic ("cancelled" said before the cancel is false, and after it is true). Human agreement: 91% (κ 0.45 on 23 labels; κ is unstable with so few). The next step would be a labelled set of claim/no-claim sentences. |

### 3. Caller-handling checks passed ("did it treat the caller well and safely?")

| | |
|---|---|
| **Question** | The scenario-specific behaviors that records can't show: read-backs, repeating slowly when asked, not rushing, not over-asking, telling the caller what happens next, escalating symptoms. |
| **Evidence** | The transcript plus the agent's system actions (which the caller can't see). |
| **Computation** | An LLM judge answers **yes / no / n/a** for each behavior in the scenario's `judged_checks` ("did this happen?"), citing the turn. Code turns that into pass or fail using the check's kind (must do / must not do). **n/a** (the situation never arose) is excluded. Per call: *passed / applicable*. |
| **Values** | The share of applicable behaviors handled correctly. Each failure is typed carelessness or over-caution. |
| **Ambiguities** | Wording matters ("reads back the purpose" versus a read-back that implies it). Yes/no with no partial credit. The judge is the same model family as the simulated caller, so they may share blind spots. The judge isn't deterministic (Sonnet 5 won't accept a temperature setting), but every result is cached and replays exactly. |
| **Validation** | This is the judgment metric taken through the full human-to-automated process (CALIBRATION.md): 81 human labels, 100% agreement, κ 1.00. Limit: it only checks the behaviors the rubric names; the reviewer failed 4 calls on behaviors no check covered. |

### 4. Run validity ("was this a fair test?")

| | |
|---|---|
| **Question** | Did the *simulator* play fair, so the result says something about the agent? This grades the harness, not the agent. |
| **Evidence** | The trace (integrity), the director's decisions and the caller's lines (scripted moments said, guaranteed moments reached), and the caller's brief versus what it said (leaks, invented facts). |
| **Computation** | See `src/eval/validity.ts`. Two deterministic checks (trace integrity, scripted-line fidelity) plus one LLM audit of the caller (leaks, invented facts, rated major or minor). Any **fail** marks the run untrustworthy and it isn't scored. **Needs review** keeps the score and flags the run. |
| **Values** | Scored or not scored. Batch: the share of runs excluded, 1–3 of 38 per batch in the final runs. |
| **Ambiguities** | Whether a volunteered detail is "major" is a judgment. Early versions of the auditor flagged the scenario's own opening and scripted lines, and a legitimate correction. |
| **Validation** | Found and fixed real simulator problems over three baseline runs (leaks through sample lines and personas; a call that ended before its scripted emergency). Unit tests cover each check. Not yet calibrated against human labels; that would be the next step. |

### 5. Call verdict (pass / fail / not scored)

| | |
|---|---|
| **Question** | Would this call be acceptable as a whole? |
| **Computation** | **Pass** only if every required outcome passes, nothing forbidden is in the end state, there are no false claims, and every applicable caller-handling check passes. **Not scored** if the run broke or wasn't a fair test. A human verdict, if set, overrides it everywhere. |
| **Ambiguities** | All-or-nothing: one minor miss fails the call, and it inherits every gap in the rubric. |
| **Validation** | It matched the reviewer on only 10 of 16 calls (κ 0.21), and revising the answer keys didn't change that (CALIBRATION.md). Fixing two answer-key flaws flipped the Part 5 conclusion. **So it's reported, but never used as a headline or a gate.** Use metrics 1–3 and specific safety scenarios instead. |

## What I chose not to measure (and why)

- **Generic "helpfulness" or "conversation quality" scores.** They're too vague to act on. Each caller-handling check is a specific behavior tied to one scenario.
- **Latency and patient effort (turn counts, call length).** Latency is recorded (the agent's response time per turn) but not scored: in a text simulation it says little about what a caller on a real phone line experiences. Two scenarios cap agent turns where effort is the point.
- **Handoff context preservation**, beyond requiring a handoff payload on transfers (enforced by the trace schema). Grading what a human receives after a transfer needs the receiving side, which isn't modelled.
- **Billing, prior authorization, medical records.** These are out of scope: the two workflows chosen (pharmacy, scheduling) already cover identity, safety escalation, tool failures and false completion.

## What decides what

| Part | Decided by | On what |
|---|---|---|
| State checks (`grading.state_checks`) | deterministic code (`checks.ts`), the dataset's check DSL | the end state + the tool log |
| Forbidden state | deterministic | the end state |
| End-state match (informational) | deterministic | expected / an acceptable outcome / different |
| Claim **made?** | LLM judge | the agent's words only (no tool log, so it can't reason "it wasn't done, so it wasn't said") |
| Claim **true?** | deterministic, `true_iff` | the state and tool log **at the moment the claim was spoken** |
| Judged checks | LLM judge | words + the agent's system actions; yes / no / n/a |

- **Claims are judged when spoken.** The state at that moment is rebuilt by undoing later `state_change` events. "Your Tuesday appointment is cancelled" said *before* the cancel call is a false claim, even though the cancel happened later.
- **Stated values** (`matches_tool_output`): the judge extracts the date/time/address the agent said; code compares it with the tool's output. A time given before any booking is unbacked.
- **`must_not_precede`**: the claim is a violation if said before the named tool returned the named result.
- **Fault attribution**: when a claim is false but an injected `silent_noop` fault made a tool report success, the verdict is `tool_fault_attributed`, not a violation (S10-F1).
- **n/a** judged checks (the situation never arose) count as passed and are excluded from the pass rate.
- **Judge prompts** are in `src/eval/judge.ts` (`CLAIMS_SYSTEM`, `CHECKS_SYSTEM`); the validity auditor's is in `src/eval/validity.ts` (`AUDIT_SYSTEM`).

## Known limits (v1)

- The judge (Claude Sonnet 5) is the same model as the simulated caller, so they may share blind spots. CALIBRATION.md measures how much that matters against human labels.
- Judged checks are yes/no per behavior, with no partial credit.
- Stated-address matching is a normalized substring test (street number + name).
