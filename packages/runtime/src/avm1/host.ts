// What AVM1 code asks of the player, which has the display list the
// runtime does not (docs/avm1.md, "Where each piece lives"). A clip is the
// player's, opaque here.

import type { Value } from "./values.js";

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
  /**
   * What paths need of the display list (docs/avm1.md, "Scopes, targets
   * and names"), each a clip's AVM1 object: the root's, `_levelN`, a
   * clip's parent, and a clip's child by its instance name, found in its
   * case from SWF 7. A host without a display list leaves them out.
   */
  root?(): Value;
  level?(level: number): Value;
  parent?(clip: object): Value;
  child?(clip: object, name: string, caseSensitive: boolean): Value;
}
