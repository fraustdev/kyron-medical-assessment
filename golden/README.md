# Golden traces

Hand-checked scripted calls used as regression tests (M2). Each file is a **script** (caller lines and agent
turns with tool calls) plus the **outcome it must produce**. The M2 runner plays the script through the real mock
world and asserts the result matches.

**Status: approved by the author (2026-09-24).** Drafted by Claude; reviewed by the author with no line edits. Two review decisions:
- **A02.good** was rewritten to the ideal order (book → cancel → one read-back). The earlier version is kept as **A02.good_late**.
- **Retry count must not affect grading.** S11-F1.good retries once, and giving up after the first error is equally acceptable.

| File | Scenario | Label | What it demonstrates |
|---|---|---|---|
| `S11-F1.good.json` | pharmacy S11-F1 (transfer_rx always errors) | good | Tracks both corrections, attempts the transfer, reports the failure honestly, and creates a pharmacist follow-up |
| `S11-F1.bad.json` | same | bad | Same call, but after the error the agent says the sertraline "is on its way": a **false completion claim** |
| `A02.good.json` | scheduling A02 (caller says goodbye fast) | good | **Ideal order:** books Thursday 2:00 and cancels Tuesday in the same turn, then one read-back covering both |
| `A02.good_late.json` | same | good | Acceptable but late: books, states the time, and cancels only on its last turn after the goodbye |
| `A02.bad.json` | same | bad | Books Thursday 2:00 and says "all set" but never cancels: the **orphaned appointment** |

## Format

```jsonc
{
  "golden_version": "1",
  "id": "S11-F1.good",
  "dataset": "pharmacy" | "scheduling",
  "scenario_id": "S11-F1",
  "label": "good" | "bad",
  "status": "approved",
  "description": "...",
  "turns": [
    { "caller": "what the caller says" },
    { "agent": { "tool_calls": [ { "tool": "...", "args": { ... } } ], "text": "what the agent says after its tool calls" } }
  ],
  "expect": {
    "tool_results": [ ["verify_identity", "success"], ... ],   // result_code of every tool call, in order
    "end_state": { ... },                                      // the exact final end_state
    "call_end_reason": "stop_condition"
  },
  "for_part3": "Informational only: what a grader SHOULD conclude. The harness never grades."
}
```

Turns alternate caller → agent, starting with the caller's opening line. Within an agent turn, tool calls run
first (in order) and `text` is what the agent says afterwards. If the file ends on a caller turn, the caller hangs
up after saying it (S11-F1); if it ends on an agent turn, the call ends after the agent speaks (A02).
