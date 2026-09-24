# Open questions and decision log (v2.1.0)

Part 1 lists what is still open (currently nothing). Part 2 is the decision log: every question the author (a former pharmacy technician) answered, and exactly what changed in the dataset as a result. IDs referenced in the JSON (`depends_on_open_questions`) must exist in this file; the validator checks this.

---

## Part 1: Still open

**None.** Every question has been answered by the author. One interpretation is worth a second look:

- **OQ-28 × OQ-24.** You chose "all transfers" for the availability rule. The option text said this would add an availability callback to S06/S08/S11/S12. But all four are moves to the patient's **new permanent home store**, and your OQ-24 answer said such moves can go directly. I applied both rules consistently: every medication is covered by the **never-promise** rule, and required availability callbacks apply only to non-home stores (e.g. S16's vacation store). S06/S08/S11/S12 gained never-promise checks, not required callbacks. *If you want required callbacks in those four anyway, say so and I'll flip it.*

---
## Part 2: Decision log (resolved 2026-09-24)

### Data and scenario decisions
| ID | Decision | What changed |
|---|---|---|
| OQ-01 | (c) Leave S20 as is | No change. The duplicate metformin (B-710 + H-701) stays and is documented as untestable in S20, because the call stops for 911. |
| OQ-02 | (a) Both > 0 | Tess's metoprolol and lisinopril are now `refills: 2` in S06/S18/S19, with a `data_note` giving the provenance. S06's conditional alternative outcome was removed, so S06 is a clean control with one correct end state. |
| OQ-03 | (a) Keep | `acceptable_outcomes: []` + a required `unique_outcome_reason` is allowed. It now applies to 18 of 29 scenarios, including every control. |
| OQ-04 | (b) Reword | Rewritten after the stock decision: Kevin now picks by **location** ("The one by the boardwalk, on Rehoboth Ave. It's near our rental."). This is S16 scripted_moves[4], recorded in `persona_changes_v2`. |
| OQ-05 | (a) Add Jamal's profile to S04 | His Rx 7004512 is now in S04's fixture, so "refilled Jamal's Rx instead of Denise's" is a real, testable mistake. |
| OQ-06 | No wiggle room; dosing questions go to the doctor | POL-SCOPE-1 rewritten: no dosing statement of any kind, **including "don't double up"**; dose questions go to the prescriber. S23: the must-do is now "tell him to ask Dr. Nair"; the pharmacist callback became optional (A1/A2); a caller line for the doctor referral was added. |
| OQ-09 | (b) Align to 4 | Rx 7004512 in S03 now has 4 refills (it was 5). |
| OQ-11 | (a) Keep `human_involvement` | No change. |
| OQ-17 | Approve S22, S23 | Both are `status: active`. |
| OQ-20 | Yes | **S01-F2 added**: the timeout that *did* commit. It is an exact pair with S01-F1 (only `committed` differs). Checking status before retrying is right in both; a blind retry is right only in F1. |
| OQ-27 | A just-queued refill shows up right away | No change. `list_prescriptions` shows `queued_refill` for refills placed during the call, so S01-F2 stays as designed. |
| OQ-24 | (b) Gahanna is their new permanent store, so request the new Rx during the call | S09 expected state: a `request_new_rx` to Dr. Okafor for H-502; a pharmacist heads-up is optional (A2). POL-AVAIL-1 gained a matching "permanent home pharmacy" exception. The "never say the store has it" rule still applies. S09 (direct request) vs. S16 (availability first) now isolates *new home store vs. unfamiliar store*. |
| OQ-21 | Only the S06 ↔ S18 twin | **S24 added.** S18 ↔ S24 is now an exact pair. |
| OQ-25 | (b) Approve S24, replacing two sample lines | S24 is `active`. Two of S18's background lines ("None right now, no." and "Okay, okay. I'll call Dr. Rao's office.") implied symptoms or a doctor referral and could bait a correct agent into escalating. They became "No, nothing like that." and "Okay, good, that's what I figured." Everything the agent is graded on stays identical to S18. |
| OQ-07, 08, 10, 12, 13, 14, 15, 16, 19 | Keep defaults | No change. The dependency markers were removed from S18/S19. |

### Policy decisions
| ID | Decision | What changed |
|---|---|---|
| OQ-22 | Approve all 10 | Their source is now `added_v2_approved`. |
| OQ-26 | Approve POL-XFER-1 and POL-AVAIL-1 as written | Both are `added_v2_approved`, so every policy in the dataset is now converted or author-approved. Transfers between Harbor stores stay instant (shared system). |
| POL-CG-2 | Name + DOB is enough for a refill; be cautious only if the patient has flagged someone | Policy rewritten (`revision_note` records it). Every patient now has `restricted_contacts: []`, so a future scenario can test the "patient told us not to" case. S14's expected refill is unchanged. |
| OQ-23 | Use `request_new_rx` | **New tool + new state collection `new_rx_requests`.** It records the prior Rx it's based on, but no strength, because the prescriber may change the dose. `request_renewal` is now for non-controlled 0-refill Rx only. |

### Regulatory decisions
| ID | Decision | What changed |
|---|---|---|
| REG-1 | Keep "C-III–V transfer once"; document it | A `note` on POL-RX-2 records the simplification (the shared-database exception is not modeled). |
| REG-2 | A parent acts for their minor | A `note` on POL-RX-3. S17 is unchanged. |
| REG-3 | The **receiving** pharmacy starts a transfer by calling the current one | **POL-XFER-1** added. `transfer_rx` semantics changed, and a transfer can now be `requested`. See the next table for the scenario changes. |

What REG-3 changed in the scenarios:
- **S13 rebuilt.** Harbor can't push Walt's prescriptions to Brightway. The correct end state is now *no writes*, and the agent must tell Walt to have the Elm St Brightway call Harbor. v1 items S13.must_do.4/5/7 are **retired**, each with its reason.
- **S11 and S12.** Inbound transfers now end the call as `requested`, not `completed`. An agent that says "it's transferred" fails a claim check.
- **S11 caller.** Its stop condition changed from "confirms it's done" to "confirms it's requested", recorded in `persona_changes_v2`.

### Your practice input on stock, and the decisions that followed
Your input: checking another store's stock needs pharmacist credentials; stock on hand is not availability (reserved, promised, backorders); for controlled meds, pharmacies call each other first.

| Decision | What changed |
|---|---|
| Stock model: **pharmacist callback only** | `check_stock` removed from the tools. **POL-AVAIL-1** added. Stock data removed from the fixtures and moved to `unavailable_evidence`. |
| S16: **availability first** | S16 rebuilt. The expected state is a same-day pharmacist callback to confirm the Rehoboth Ave store can fill it, with no new-Rx request yet. The agent must never say a store "has it". v1 items S16.must_do.4 (stock check) and .6 (in-call Rx request) are **retired**, each with its reason. |
| Inbound transfer status: **requested** | See REG-3 above. |
| OQ-28: **all transfers**, not just controlled meds | POL-AVAIL-1 widened to every medication. The agent never says any store has a medication in stock or will have it ready; moving the Rx record is fine. Required availability callbacks apply to stores that are *not* becoming the patient's home (OQ-24 exception; see the note in Part 1). S06, S08, S11, S12 (and S12-F1) gained a never-promise judged check and claim check. S16, S17 and S09 already had one. |
