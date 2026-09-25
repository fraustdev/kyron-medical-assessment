/**
 * Decides which (if any) of a scenario's tool_faults applies to a tool call.
 * on_call is the 1-based index among calls to that tool that match the fault's optional `match` filter.
 */
import type { ToolFault } from "./dataset.js";

export interface MatchedFault { index: number; fault: ToolFault }

export class FaultInjector {
  private counts = new Map<number, number>();
  constructor(private readonly faults: ToolFault[]) {}

  /** Call exactly once per tool call (it advances the per-fault call counters). */
  next(tool: string, args: Record<string, unknown>): MatchedFault | null {
    let chosen: MatchedFault | null = null;
    this.faults.forEach((fault, index) => {
      if (fault.tool !== tool || !matches(fault, args)) return;
      const n = (this.counts.get(index) ?? 0) + 1;
      this.counts.set(index, n);
      if (chosen === null && (fault.on_call === "all" || fault.on_call === n)) chosen = { index, fault };
    });
    return chosen;
  }
}

function matches(fault: ToolFault, args: Record<string, unknown>): boolean {
  const needle = fault.match?.query_contains;
  if (!needle) return true;
  return Object.values(args).some((v) => typeof v === "string" && v.toLowerCase().includes(needle.toLowerCase()));
}
