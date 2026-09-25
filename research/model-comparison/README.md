# Agent model comparison (M3)

Before choosing the agent under test, several models were run through the same two scripted calls
(A02.good and S11-F1.good, with the caller replaying the golden caller lines verbatim):

| Model | Result |
|---|---|
| qwen2.5:7b (local) | Narrated tool calls instead of making them; claimed a booking and cancellation that never happened. |
| llama3.1:8b (local) | Used tools, but claimed a cancellation it never made and promised a callback it never filed. |
| qwen3:8b, thinking off (local) | Left the original appointment in place (double-booked); made no tool calls at all on S11-F1. |
| qwen3:8b, thinking on (local) | Truthful, but 20–45 s per turn and still made wrong calls. |
| claude-haiku-4-5 | Used tools correctly and never claimed an action that didn't happen; over-strict on clinic ID. **Chosen as agent v1.** |

These are kept as evidence for that decision. They are not evaluation runs, so the app doesn't load them.
Rerun one with `AGENT_MODEL=<model> npx tsx src/cli/smoke-agent.ts A02.good replay`.
