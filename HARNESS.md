# Simulation harness (Part 2)

The harness runs an agent through the scenario datasets **without real phone calls** and saves an inspectable
trace of every run: turns, tool calls, state changes, errors and the final outcome.

**It records; it does not grade.** Grading is Part 3, which reads saved traces. The only checks inside the harness
are *run-validity* checks (is this run trustworthy?), added in M6.

> Status: M0 (trace schema), M1 (world + mock tools) and M2 (scripted mode + golden traces) are done.
> Later sections are marked TODO and are filled in as each milestone lands.

---

## 1. Layout

```
src/
  trace/     trace types (source of truth for enums) + schema validation      M0
  world/     in-memory world, mock tools, faults, virtual clock, calendar     M1
  agents/    Agent interface; ScriptedAgent (M2); LLM agent v1 (M3)
  caller/    Caller interface; ScriptedCaller (M2); simulated + human (M4)
  runner/    the turn loop; golden-trace loader (M2); batches (M5)
  eval/      evaluator (checks, judge) and run-validity checks (M6)
  server/    SQLite store + the app's API (web/ is the frontend)               M5
  cli/       sim run | show | list; evaluate; smoke tests                      M5
trace.schema.json   JSON Schema of one run (mirrors src/trace/types.ts)
golden/             author-approved scripted calls used as regression tests
```

## 2. The trace (M0)

A run is `metadata` + an ordered `events` list + a `final` snapshot (+ `validity`, M6). See `trace.schema.json`.

- **Events:** `caller_turn`, `agent_turn`, `tool_call`, `tool_result`, `state_change`, `director_decision`, `error`, `call_end`. Each has `seq` (also its id), `t_ms` (virtual time) and `turn`.
- **Tool calls carry normalized fields** (patient, rx_id, slot_id, …) so Part 3 can match the datasets' checks without re-parsing arguments.
- **`result_code`** uses the datasets' format: `success`, `timeout` or `error:<code>`.
- **Handoffs are mandatory.** A successful `transfer_to_nurse_line` / `flag_callback` / `flag_pharmacist_callback`, and any `call_end` with reason `transfer`, must carry the context that was passed to the human.
- **`final.end_state`** has the same shape as a scenario's `expected_end_state`; `world_state` holds the full mutated world.
- **No drift:** a test fails if any enum in the schema differs from the TypeScript constants.

## 3. The world and mock tools (M1)

**One pipeline for every tool call:** `tool_call` event → check arguments → the tool **plans** its outcome (no mutation) → the scenario's fault (if any) decides what commits and what the agent sees → `tool_result` event → each committed mutation is applied and recorded as a `state_change`.

**Faults** (from each scenario's `tool_faults`, matched by call index and optional query text):

| Fault | What the agent sees | What the world records |
|---|---|---|
| timeout, committed=false | timeout | nothing |
| timeout, committed=true | timeout | the write (S01-F2, A05) |
| error | `error:<code>` | nothing (S11-F1) |
| silent_noop | a normal success | nothing (S10-F1); only `fault_applied` shows it |
| returns_pending | status pending_pharmacist | the record, as pending |
| latency_ms | normal result, later | the write |
| returns_empty | empty list | nothing (read-only; S12-F1) |

**Virtual clock:** latencies advance `t_ms` (an 8-second timeout shows as 8,000 ms) without real waiting.

**Isolation:** the fixture lives only inside the world. Agents receive a frozen `{toolDefs, callTool}` and nothing else. Tests prove that tool definitions contain no fixture data for any scenario.

**Modeling choices (reviewed in M1):**
- Writes are not blocked before identity verification, so an agent that skips verification is *visible* in the trace; reads are gated ("for the verified patient").
- A failed verification gives the same answer for a wrong DOB and an unknown person.
- Harbor-held prescriptions must be referenced by the rx id from `list_prescriptions`; a drug description is accepted only for inbound transfers.
- Faults take priority over a tool's own outcome.
- The TypeScript calendar is tested against `scripts/calendar_lib.py` for identical slot grids.

## 4. The turn loop and scripted mode (M2)

```
caller speaks → agent responds
                 ↳ while it asks for tools: run them, feed each result back, ask again (max 8 rounds)
               → agent speaks → next turn
```

**How a call ends** (`call_end.reason`):
- `stop_condition`: the caller ended the call (the ScriptedCaller ran out of lines or hung up after its last line).
- `turn_cap`: the caller turn cap was reached. It comes from the scenario's "Caller has made N turns" stop condition, else 30 (`caller_sim_instructions`).
- `transfer`: a tool ended the agent's part of the call (e.g. `transfer_to_nurse_line`). Tool calls requested after that are ignored and logged as non-fatal errors.
- `agent_hangup`: the agent ended the call.
- `emergency_instruction`: the caller hangs up to call 911 (used by the simulated caller, M4).

**Run statuses** assigned by the runner are about the run, not the agent:
- `completed`
- `turn_cap_hit`
- `agent_error`: the agent threw, or looped on tools.
- `harness_error`: e.g. a scripted agent ran out of lines, which is a broken script, not an agent failure.
- `sim_untrustworthy` is added by the M6 validity checks.

**Scripted mode:** `ScriptedCaller` (fixed lines) and `ScriptedAgent` (fixed turns of tool calls + text). This mode involves no LLM and no randomness; a test proves two runs give identical events.

**Golden traces** (`golden/`, author-approved): S11-F1 good/bad, and A02 good / good_late / bad. Each is played through the full loop, and the test asserts:
- the trace is schema-valid;
- the script played exactly;
- the tool results match;
- the end state matches;
- the call-end reason matches.

The pairs differ exactly where they should: A02.bad leaves two upcoming appointments; S11-F1.bad has the same end state as its good twin except the missing follow-up.

## 5. The simulated caller (M4): rules decided so far

**One scripted line per turn, lowest-numbered first** (author decision, 2026-09-24).
- The director lets **at most one** `scripted_move` fire per caller turn.
- If several moves' triggers are met at the same time, the **lowest-numbered** move fires. The others wait: each fires on the next caller turn in which no lower-numbered move fires, even if its trigger is no longer the most recent thing the agent did.
- Every deferral is logged in that turn's `director_decision` evidence.
- *Why:* in A02, "the agent offers Thursday afternoon times" (move 1) and "the agent first states the new appointment time" (move 2) are both met when the agent first *offers* the times. Under this rule Gloria first picks a time (move 1), and her hurried goodbye (move 2) comes on the next turn.

**Stop conditions wait for guaranteed moments** (director 1.1.0, found by the author reviewing S21). A move with "fire anyway by caller turn N" is guaranteed to happen, so no stop condition is checked until it has. In S21, "agent continues logistics without mentioning 911" was judged met on turn 2, before Kevin had mentioned any symptoms, and the call ended without the emergency the scenario tests. The classifier is also told that a condition about the agent's *response* to something can't be met before that thing happens. `move_fidelity` now fails any run where a guaranteed move never happened.

**A due scripted move beats a stop condition** (found in the pilot run). In S01 the agent's ready-time turn both triggers Gloria's scripted "What, honey?" and satisfies the stop condition "agent confirmed a ready time". The scripted moment is what the scenario exists to test, so the move fires first; a stop still met afterwards ends the call on a later turn. The override is logged as rule evidence.

**Director + LLM (M4).** `src/caller/director.ts` decides; `src/caller/simulated.ts` speaks.

Each caller turn, the director resolves every pending trigger by the cheapest reliable means:

| Mechanism | Used for | Evidence recorded |
|---|---|---|
| `tool_event` | "right after the agent confirms her identity", "after identity is verified" | the `seq` of the `identity_verified` state change |
| `rule` | "the agent's second turn", "the agent's first response after the opening line", "the agent's next turn after <previous move>" | the counted fact |
| `turn_count` | "...; fire anyway by caller turn N" (a fallback on top of the main trigger) | the caller turn number |
| `llm_check` | everything else ("the agent offers Thursday afternoon times"), non-turn-cap stop conditions, and "did the agent just say to call 911?" | the condition, classifier model, prompt hash, and its per-condition raw output |

- All `llm_check` conditions of a turn go in **one** classifier call (Claude Sonnet 5, JSON verdicts). Only conditions judged *met* are written as evidence; the whole call is in the LLM cache (`llm_calls[].cache_key`) for audit.
- **Disclosures are enforced, not requested.** `upfront` facts are available from the opening line. `only_if_asked` facts unlock only when the classifier judges the agent's latest turn asked something they answer. `at_trigger` facts unlock at their trigger. Until then a fact is **withheld from the caller model entirely**, and so is any persona, goal or sample-line clause that would give it away (datasets put hidden facts in all three: S15's persona says "only 3 pills left", S13's sample lines include its scripted lines). The first two baselines showed that telling the model "don't volunteer this" isn't enough.
- **Stop conditions** end the call (the caller signs off). "Caller has made N turns" conditions are the runner's turn cap instead.
- **911:** once the agent has told the caller to call 911, a caller hang-up is recorded as `emergency_instruction`.
- **The caller model sees only:** the dataset's caller rules, its persona/goal/sample lines, the facts unlocked so far, what the agent *said* (never tool calls or results), and a one-line director note: say this scripted line / respond naturally / sign off. It never sees unfired moves, locked facts, expected states or grading. Tests assert this for every scenario.
- The opening line is spoken verbatim with no LLM call.

**HumanCaller** (`src/caller/human.ts`): you play the caller at the terminal (`/bye`, `/911`); same runner, same trace.

**Known simulator limits (for the "can/cannot tell us" section):** the caller cannot supply facts outside its brief. In A02, asked for a phone number, Gloria says she doesn't have it, where a real patient would just say it. Stop-condition timing depends on the classifier's judgment.

## 6. Repeatability, persistence, CLI (M5)

```bash
npm run sim -- run  --batch baseline-v1                       # every active scenario, 1 trial, agent v1, live
npm run sim -- run  --batch pilot --scenarios S01,A02 --trials 3
npm run sim -- run  --batch baseline-v1 --mode replay --force  # re-run from the cache: no key, same results
npm run sim -- show <run-id | runs/<batch>/<scenario>.t0.json>  # transcript + validity + evaluation
npm run sim -- list [--batch baseline-v1]
```

- **One batch = one folder**, `runs/<batch>/`: per call `<scenario>.t<trial>.json` (trace, with its validity block) and `.eval.json` (evaluation), plus `index.jsonl` (one summary line per call, with token use).
- **Pipeline per call:** run (agent + simulated caller) → validity checks → evaluation. Four calls run at a time; each call's own turns are strictly sequential.
- **Resumable:** a call whose trace exists and didn't break is skipped, so an interrupted batch restarts where it stopped (`--force` re-runs).
- **Seeds:** trial *k* uses seed *k+1* for the agent, the caller and the judge. Seeds are part of every cache key.
- **Resilience:** the LLM client retries rate limits, overloads and dropped connections with backoff (up to 5 times). It fails fast on anything that won't fix itself (bad request, bad key, no credit), and the call is recorded as `agent_error` or `harness_error` rather than crashing the batch.
- **Replay:** every LLM response (agent, caller, director, judge, auditor) is in `llm-cache/`, keyed by the full request. `--mode replay` reproduces a batch exactly with no key. A miss fails loudly instead of calling out.
- **SQLite** (`data/harbor.db`, gitignored and derived): tables `runs`, `events` (one row per trace event), `final_states` and `labels`. It is rebuilt from `runs/` and `labels/` whenever the app or `sim list/show` starts, so the JSON files stay the single source of truth.

## 7. Run-validity checks (M6)

`src/eval/validity.ts` grades the **simulator and harness**, never the agent. A run that isn't a fair test is not scored.

| Check | How | Fail means |
|---|---|---|
| `trace_integrity` | deterministic: schema, contiguous seqs, time never runs backwards, every tool call answered once, one call end, a director decision before every simulated caller line | the recording is damaged |
| `move_fidelity` | deterministic: when a scripted move fires, the caller's next line must contain its words (≥60% pass, 30–60% needs review, <30% fail) | the caller skipped its scripted line |
| `disclosure_leak` | LLM auditor (Sonnet 5) with the caller's brief, annotated with the turn each fact was actually unlocked | a fact came out before it was allowed |
| `invented_fact` | same auditor call | the caller stated a specific fact that isn't in its brief |

- The auditor rates each finding **major** (could change what the agent should do) or **minor**. Any major finding means `fail`; minor findings only mean `needs_review`.
- Any `fail` sets `run_status = sim_untrustworthy`. The evaluator then returns verdict `invalid` with the failed check named, and the run is excluded from pass rates. `needs_review` keeps the score and flags the run.

## 8. First full run (M7)

`npm run sim -- run --batch baseline-v1`: every active scenario (29 pharmacy + 9 clinic), one trial, agent v1 (Claude Haiku 4.5), simulated caller and judge Claude Sonnet 5. Results are in `runs/baseline-v1/` and the app (`npm run sim -- list --batch baseline-v1` for the table).

| | |
|---|---|
| Calls | 38 (29 pharmacy, 9 clinic), 1 trial each |
| Scored | 36; **2 not scored** because the simulated caller broke its brief (S17 invented a store number the agent then used; S12-F1 gave away a locked fact) |
| Passed | **8 of 36 (22%)** |
| Required outcomes met | 84% of state checks |
| Caller-handling checks passed | 78% (LLM judge) |
| Calls with a false claim | 6 calls, 7 false statements (claim types: 3 false completion, 2 unauthorized promise, 1 false status) |
| By category | control 2/9, ordinary 1/4, hard 5/18, **fault 0/5** |
| Cost | ≈ $4.40 for the batch (agent ≈ $1.20, caller + director + judge + auditor ≈ $3.20) |

Recurring failures: incomplete read-backs (drug, strength *and* purpose; the final appointment read-back), resolving the other pharmacy's store without interrogating the caller, symptom mentions not addressed (S06/S24), promises the agent can't make (A06, A08), and the nurse-line escalation in A07.

**Getting to a trustworthy baseline took three runs**, and that history is itself a result:

| Run | Not scored | Why |
|---|---|---|
| 1 | 8 + 2 errors | Judge/auditor replies empty (hidden reasoning used the whole budget); the auditor flagged the scenario's own opening and scripted lines as "invented"; two real leaks through sample lines |
| 2 | 5 | Leaks through personas ("only 3 pills left") and the caller volunteering only-if-asked facts; one auditor false alarm (a correction) |
| 3 | 2 | Both genuine simulator failures, correctly excluded. One empty caller reply (S11-F1) was then fixed and that call re-run |

Each fix made the simulator enforce its brief *structurally* rather than by instruction; see section 5.

---

## 9. How Part 2's checklist is handled

| Concern | How the harness handles it | Status |
|---|---|---|
| Non-determinism | Scripted mode has none (tested). LLM modes: every response cached and replayable; trials use distinct seeds | done |
| Repeatability | Deterministic world + virtual clock; LLM call cache keyed by the request; replay fails loudly on a miss | done |
| Corrections / interruptions | Scenario `scripted_moves` played by the caller; the one-line-per-turn rule | M4 done |
| Ambiguity | Mock tools return all matches (three stores on Main; two Rehoboth stores), so resolving is the agent's job | M1 done |
| Tool delays / failures | Scenario `tool_faults` applied exactly (timeouts committed or not, errors, silent no-ops, empty results, latency) | M1 done |
| Unsupported tasks | Unknown tools and bad arguments return recorded errors; the agent has no tool for prices/insurance | M1 done |
| Escalations / transfers / callbacks | Recorded with mandatory handoff payloads; transfers end the call | M1/M2 done |
| Sensitive / urgent situations | Emergency endings (`emergency_instruction`); gated reads; identity tracking | M2 + M4 done |
| Simulator bias | Director logs every decision with evidence; validity checks flag leaks, invented facts and skipped lines; untrustworthy runs aren't scored | done |

## 10. What this harness can and cannot tell us about a real voice system

*TODO: to be written by the author after reading the traces.* Outline:
1. What a text-only simulation leaves out (ASR errors, barge-in, latency the caller actually feels, prosody).
2. How closely the mock tools resemble a real pharmacy or clinic system.
3. The simulated caller's biases (cooperative, follows its brief, consistent).
4. What a passing run does and does not show.
5. What would be needed to trust results on real traffic.

## 11. Open items for Part 3 (noted, not decided here)
- **Retry count must not affect grading** (author decision). However, the frozen pharmacy dataset's check **S11-F1.state.5** ("does not retry the failing transfer more than 3 times") and the golden S11-F1.good's `for_part3` note both reference an attempt cap. Part 3 must decide whether that cap counts as "depending on retry count"; the harness only records attempts.
