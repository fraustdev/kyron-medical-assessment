/** ScriptedCaller: says a fixed list of lines, one per turn, regardless of what the agent says. */
import type { Caller, CallerInfo, CallerUtterance } from "./types.js";

export class ScriptedCaller implements Caller {
  private i = 0;
  /**
   * @param lines what the caller says, in order
   * @param hangUpAfterLast true if the caller hangs up right after the last line (no agent reply);
   *        false if the call ends only after the agent replies to the last line
   */
  constructor(private readonly lines: string[], private readonly hangUpAfterLast = false) {}

  info(): CallerInfo {
    return { type: "scripted", provider: null, model: null, director_version: null };
  }

  async next(): Promise<CallerUtterance | null> {
    const text = this.lines[this.i];
    if (text === undefined) return null;
    this.i += 1;
    const last = this.i === this.lines.length;
    return last && this.hangUpAfterLast
      ? { text, hang_up_after: true, end_reason: "stop_condition", end_detail: "Caller hung up after the last scripted line." }
      : { text };
  }

  remaining(): number { return this.lines.length - this.i; }
}
