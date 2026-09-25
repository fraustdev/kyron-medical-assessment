/**
 * Virtual clock + event recorder. Every component (world, caller, agent, runner) appends events here.
 * The clock is virtual: a tool "taking 8 seconds" advances t_ms by 8000 without actually waiting.
 */
import type { TraceEvent } from "../trace/types.js";

export class VirtualClock {
  private ms = 0;
  now(): number { return this.ms; }
  advance(ms: number): void {
    if (!(ms >= 0)) throw new Error(`clock cannot move backwards (${ms})`);
    this.ms += ms;
  }
}

/** Distributes Omit over the event union so each variant keeps its own fields. */
export type NewEvent = TraceEvent extends infer E ? (E extends TraceEvent ? Omit<E, "seq" | "t_ms" | "turn"> : never) : never;

export class Recorder {
  readonly events: TraceEvent[] = [];
  /** The runner sets the current conversation turn; events inherit it. */
  turn = 0;
  constructor(readonly clock: VirtualClock = new VirtualClock()) {}

  emit<E extends NewEvent>(e: E): TraceEvent {
    const ev = { seq: this.events.length, t_ms: this.clock.now(), turn: this.turn, ...e } as unknown as TraceEvent;
    this.events.push(ev);
    return ev;
  }
}
