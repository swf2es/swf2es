// What ends an AVM1 block other than its code: an action not done yet, the
// SWF stopped at one Flash cannot read, or its actions disabled; and a value
// the code throws.
import type { Value } from "./values.js";

/** An action the runtime does not do yet: it ends the block it is in. */
export class NotYet extends Error {
  override name = "Avm1NotYet";
}

/**
 * Thrown once the host has stopped the SWF at an action Flash cannot read,
 * to end whatever runs; the player takes it for no error.
 */
export class Halt extends Error {
  override name = "Avm1Halt";
}

/**
 * Thrown past Flash's recursion limit: Flash disables every action of the
 * movie from there, and its timelines play on.
 */
export class Disabled extends Error {
  override name = "Avm1Disabled";
}

/**
 * A value AVM1 code throws (Throw), which a Try's catch or finally takes
 * and which, caught by none, ends the block as Flash ends it, silently.
 */
export class Avm1Throw extends Error {
  override name = "Avm1Throw";

  constructor(readonly value: Value) {
    super("an AVM1 value thrown and not caught");
  }
}
