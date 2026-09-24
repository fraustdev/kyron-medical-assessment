# Schema changelog: `scenario.schema.json`

One schema serves both datasets. The dataset is detected from the `dataset` field, and dataset-specific requirements live in top-level `if/then` blocks. The pharmacy dataset (`pharmacy_call_scenarios.v2.json`, v2.1.0) validates unchanged under every version below.

## v2.2.1: decisions made through open questions
- Policy `source` also accepts `author_decision:OQS-nn` / `author_decision:OQ-nn`, for policies set by the author's answer to an open question (e.g. POL-SCH-DATE-1, from OQS-02).

## v2.2: clinic scheduling support (added for `scheduling_call_scenarios.v1.json`)

### Top level
| Change | Why |
|---|---|
| `dataset` is now an enum: `harbor-pharmacy-call-scenarios` \| `harbor-clinic-scheduling-scenarios` | Selects the dataset-specific rules below |
| `stores` is required **only for pharmacy**; `providers`, `visit_types` and `calendar` are required **only for scheduling** | The clinic has providers and a slot calendar instead of stores |
| `agent_context` requires `tools` + `policies` generally; `pharmacy_name` + `outside_chain` (pharmacy) or `clinic_name` (scheduling) conditionally | Each customer names itself differently |
| `workflows` requires the three pharmacy workflows only for pharmacy, and `appointment_scheduling` for scheduling | The workflow list is per dataset |
| `version` pattern relaxed from `^2.x.y` to any semver | The scheduling dataset starts at 1.0.0 |
| New `providers`, `visit_types` and `calendar` definitions | Decisions D2 and D4; the calendar is a deterministic generator spec (see `scripts/calendar_lib.py`) |

### Policies
| Change | Why |
|---|---|
| `id` pattern `^POL(-[A-Z]+)+-\d+$` (was `^POL-[A-Z]+-\d+$`) | Allows `POL-SCH-CG-1` |
| `source` also accepts `author_decision:D<n>` and `added_needs_review` | Marks policies taken from D1–D7 vs. ones added for review |
| `tier` enum adds `nurse_same_day` | D5 same-day triage |

### Scenarios
| Change | Why |
|---|---|
| `id`, `parent_id` and check-id patterns accept an `A` prefix (`^[SA]\d{2}...`) | Scheduling scenario ids A01–A09 |
| Exactly one of `pharmacy_fixture` / **`clinic_fixture`** is required (was: `pharmacy_fixture` required) | New fixture type: patients, appointments, open_slots, external_records |
| New `twin_of` + `twin_varies` (required together) | Declared exact twins; the validator enforces that only the listed fields differ |
| New `related_scenarios` `[{dataset, scenario_id, relation}]` | Cross-workflow links (A07→S18, A08→S10, A09→S24) |
| `task_type` adds `reschedule`, `book`, `cancel` | Scheduling tasks |
| `urgency_tier` adds `nurse_same_day`; `escalation.target` adds `nurse_line`; `human_involvement.who` adds `nurse`, `clinic staff` | D5 triage path |
| `critical_entities.type` adds `appointment_id`, `slot_id`, `provider`, `visit_type` | Scheduling entities |
| `hard_case_tags` adds `caller_pacing`, `ambiguous_date`, `ambiguous_appointment`, `no_availability`, `cross_workflow` | Scheduling hard cases |
| `workflow` adds `appointment_scheduling` | New workflow |
| `depends_on_open_questions` and `conditional_on_open_question` accept `OQS-nn` | Separate open-questions file for scheduling |
| `expected_end_state` / `acceptable_outcomes[].end_state_delta` = pharmacy end state **or** scheduling end state (`anyOf`) | Different state collections per dataset |

### State, checks and tools
| Change | Why |
|---|---|
| New collections `bookings`, `cancellations`, `waitlist_entries`, `callbacks`, `nurse_line_transfers`, with strict record schemas | The scheduling ground truth (the appointment state) |
| `tool_name` adds `list_appointments`, `find_slots`, `book_appointment`, `cancel_appointment`, `add_to_waitlist`, `flag_callback`, `transfer_to_nurse_line` | D3 tools |
| `where` fields add `slot_id`, `appointment_id`, `provider`, `visit_type` | Scheduling checks |
| Check `source` accepts `authored` | Scheduling checks were authored fresh (there are no v1 items to map) |

### Moved from the schema to the validator
Tool names and collection names are unions across both datasets in the schema. **Which** tools and collections a given dataset may use is enforced by the validator's new `vocabulary` section, against that dataset's own `agent_context.tools` and `state_model.collections`. A pharmacy scenario therefore cannot use `book_appointment`, and a clinic scenario cannot use `refills_queued`. A planted-defect test covers this.

## v2.1: pharmacy author decisions
`request_new_rx` / `new_rx_requests`, the `requested` transfer status, `retired_v1_items`, `persona_changes_v2`, `restricted_contacts`, `tool_called_after`, and policy `note`/`revision_note`. See OPEN_QUESTIONS.md, Part 2.

## v2.0: initial v2 schema
State-based ground truth, three check types, tool faults, policies, and the Part 1 fields.
