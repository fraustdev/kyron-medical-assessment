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

---
*Maintenance: every new decision gets one row here, in the matching section, with a one-line reason marked [me], [option] or [spec].*
