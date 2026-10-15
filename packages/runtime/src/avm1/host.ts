// What AVM1 code asks of the player, which has the display list the
// runtime does not (docs/avm1.md, "Where each piece lives"). A clip is the
// player's, opaque here.

/** A display object the player gives the runtime, as an activation's target. */
export type Target = object;

export interface Host {
  /**
   * A trace's text, as it is: Flash's log breaks its lines at a carriage
   * return as at a line feed, which is the host's to do where it writes one.
   */
  trace(text: string): void;
  /** Play or stop `target`'s timeline. */
  play(target: Target): void;
  stop(target: Target): void;
  /**
   * Stop the whole SWF, every timeline and every action of it, as Flash
   * does at an action it cannot read.
   */
  halt(): void;
}
