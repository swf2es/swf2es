// What ends an AVM1 block other than its code: an action not done yet, the
// SWF stopped at one Flash cannot read, or its actions disabled.

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
