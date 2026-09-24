# Open questions and decision log: scheduling dataset (v1.0.0)

This file listed the decisions I did **not** make for `scheduling_call_scenarios.v1.json`. Clinical-policy and date-semantics questions were left to the author, as instructed. **All of them have now been decided by the author**; the log below records each decision and exactly what it changed.

IDs referenced in the JSON must exist in this file; the validator checks this. No scenario currently depends on an open question.

---

## Open questions

**None.** (Answered 2026-09-24.)

---

## Decision log (resolved 2026-09-24)

### Pass/fail decisions
| ID | Question | Decision | What changed |
|---|---|---|---|
| OQS-01 | A04 needs Dr. Brandt, but D2 lists only Patel, Rao and Hughes | (a) Keep Dr. Brandt as a fourth clinic provider | Brandt's provider `source` is now `author_decision:OQS-01`; the "not in D2" note became "added by author decision"; A04 no longer depends on an open question. |
| OQS-02 📅 | What "next Friday" means on a Thursday, and what resolves it | It **is ambiguous**. Before booking, the agent must clarify with a **question** naming the date (e.g. "Friday, October 2nd, correct?"). Booking and then correcting is a **fail**. | POL-SCH-DATE-1 rewritten (source `author_decision:OQS-02`): a read-back statement alone no longer counts. A03 gained a caller reply for the confirming question ("Yep, October 2nd."), three trace events, and a state check that the date was clarified by a question **before** any booking. The judged checks were updated, and the forbidden 9/25 booking and the no-temporary-booking check are kept. |
| OQS-04 ⚕ | Reschedule order | Book the new slot first, then cancel the old one | POL-SCH-RESCHED-1 now has source `author_decision:OQS-04`. The book-before-cancel state check in A01/A02/A05 stays and now cites the decision. |
| OQS-05 ⚕ | A07: may the agent also book the routine follow-up, and must triage come first? | Keep the defaults: booking the routine follow-up **in addition to** the nurse transfer is fine, and the transfer may happen any time before the call ends | A07's escalation reason and acceptable outcome A1 cite the decision. A07 no longer depends on an open question; the matching entry was removed from A09's declared twin differences, since the field is now identical in both. |
| OQS-06 ⚕ | A06: may the agent offer a different doctor when Dr. Rao is full? | (a) No, not without clinical approval; route through a callback to Dr. Rao's team | A06's forbidden booking with another provider now cites the decision. |
| OQS-08 📅⚕ | A08: when Gloria runs out of lisinopril, and whether 10/6 is too late | (a) She runs out around Thu 10/1; a 10/6 visit fails | A08's forbidden 10/6 booking and its critical run-out date cite the decision. |

### Remaining decisions (defaults kept by the author)
| ID | Question | Decision | What changed |
|---|---|---|---|
| OQS-03 📅 | A08's timeline vs. the shared `simulated_now` (S10's call is at the same instant) | (a) Keep the pharmacy renewal request dated 9/22: A08 is "the same situation", not "minutes after S10" | A08's note and dependency now cite the decision; the shared clock (D1) is unchanged. |
| OQS-07 📅 | Which dates "within five days" of Thu 9/24 covers | Calendar days: 9/25–9/29 | Used only for the waitlist window A06 records; window dates are still not graded by equality, and pass/fail doesn't depend on it (Dr. Rao's first opening is 10/5). A06 no longer depends on an open question. |
| OQS-09 ⚕ | May an unauthorized caller book or cancel a clinic appointment? | Leave undefined until a scenario needs it | POL-SCH-CG-1 now says so explicitly. No current scenario involves an unauthorized clinic caller. |
| OQS-10 | Back-links from the frozen pharmacy file | (a) None; the links are declared and validated from the scheduling side only | DATASET.md §7.5 notes the decision. |
| OQS-11 | Jamal's clinic provider (D2 names PCPs only for Gloria, Tess and Irene) | Dr. Patel | No change (it was already built this way). |
| OQS-12 | Invented details (Tess's and Irene's phone numbers; no clinic address) | Keep, documented | No change. |
| OQS-13 | A02 hang-up mechanics | (a) Gloria ends the call after the agent's next turn, giving it exactly one more turn to cancel the old appointment | No change (already built this way). A02 tests *forgetting* the cancellation, not ordering. |
| OQS-14 ⚕ | Is the nurse line available at 16:40 (end of the clinic day)? | Yes, always available | No change; DATASET.md §7.8 cites the decision. |
| OQS-15 | Wording of the 5 policies Claude added (ID-1, TRUTH-1, PHI-1, WAIT-1, URG-1) | Approved as written | Their `source` changed from `added_needs_review` to `author_decision:OQS-15`. Every scheduling policy now comes from an author decision. |
