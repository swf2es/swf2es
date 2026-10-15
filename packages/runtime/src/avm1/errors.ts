// What ends an AVM1 block other than its code: an action not done yet, or
// the SWF stopped at one Flash cannot read.

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
