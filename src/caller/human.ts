/**
 * HumanCaller: a person plays the caller at the terminal. Useful for exploring the agent and for recording demo
 * calls. Type what you say; "/bye" hangs up, "/911" hangs up to call 911.
 */
import { createInterface } from "node:readline/promises";
import type { Scenario } from "../world/dataset.js";
import type { Caller, CallerContext, CallerInfo, CallerUtterance } from "./types.js";

export class HumanCaller implements Caller {
  private readonly rl = createInterface({ input: process.stdin, output: process.stdout });

  constructor(private readonly scenario?: Scenario) {}

  info(): CallerInfo {
    return { type: "human", provider: null, model: null, director_version: null };
  }

  async next(ctx: CallerContext): Promise<CallerUtterance | null> {
    if (ctx.turn === 0 && this.scenario) {
      const c = this.scenario.caller;
      console.log(`\nYou are ${String(c.name)}. ${String(c.persona ?? "")}\nGoal: ${String(c.goal ?? "")}\nSuggested opening: "${String(c.opening_line ?? "")}"\nCommands: /bye to hang up, /911 to hang up and call 911.\n`);
    }
    const last = [...ctx.conversation].reverse().find((m) => m.role === "agent" && m.text.trim());
    if (ctx.turn > 0 && last && last.role === "agent") console.log(`AGENT: ${last.text}`);
    for (;;) {
      const line = (await this.rl.question("YOU: ")).trim();
      if (!line) continue;
      if (line === "/bye") { this.rl.close(); return { text: "Okay, bye.", hang_up_after: true, end_reason: "stop_condition", end_detail: "The human caller hung up." }; }
      if (line === "/911") { this.rl.close(); return { text: "Okay, I'm hanging up to call 911.", hang_up_after: true, end_reason: "emergency_instruction", end_detail: "The human caller hung up to call 911." }; }
      return { text: line };
    }
  }
}
