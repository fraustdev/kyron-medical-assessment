# Evaluator v1 (Part 3)

`src/eval/`: one trace + its scenario → an `EvalResult` (`<trace>.eval.json`). Run it with:

```bash
npx tsx src/cli/evaluate.ts runs/baseline-v1/S20.t0.json replay   # no key needed
npx tsx src/cli/evaluate.ts <trace.json> live            # new judge calls (needs .env)
npx tsx src/cli/evaluate.ts <trace.json> --no-judge      # deterministic checks only
```

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

## Verdict

- `invalid`: the run itself broke (`agent_error` / `harness_error`); not scored.
- `pass`: every state check passes, nothing forbidden, no false claim, every applicable judged check passes.
- `fail`: anything else. `summary.reasons` lists why; `failure_types` tallies carelessness vs. over-caution.

## Known limits (v1)

- The judge (Claude Sonnet 5) is the same model as the simulated caller, so they may share blind spots. Part 3 calibrates the judge against human labels.
- Judged checks are yes/no per behavior, with no partial credit.
- Stated-address matching is a normalized substring test (street number + name).
