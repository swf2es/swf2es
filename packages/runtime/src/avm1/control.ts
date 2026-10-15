// What With and Try hold while control stays in their bytes, as adl runs
// them (docs/avm1.md, "With and Try"): not activations of their own, as
// Ruffle has them, but entries on the activation that come off as control
// leaves the blocks they hold over, however it leaves them.
//
// The compiler writes a region's blocks in order of their offsets, so a
// body's bytes are a range of its blocks, and every entry is a range: a
// With's object or a catch's variable on the scope chain while control is
// in the body; a Try's handlers while it is in the try or catch body; and a
// finally reached by a throw or a Return, which throws again or returns as
// control leaves it. Where control goes is a block of the region, -1 for
// its exit, whose value is `cx.ret`.
//
// What adl shows of when they come off: a scope one action late, so the
// first action past a body still runs in it (V.scopes, after that action),
// a Try's handlers and a finally's throw or Return at once (V.leave, as
// control goes); a throw in a With body caught by a catch outside it keeps
// the With's object, and any catch's variable, over the catch body.
import type { Activation } from "./activation.js";
import { Avm1Throw } from "./errors.js";
import { Avm1Object } from "./objects.js";
import { MAX_SCOPES, SCOPE_With, Scope } from "./scope.js";
import type { Value } from "./values.js";

/** A With's object, or a catch's variable, on the scope chain. */
const HELD_Scope = 0;
const HELD_Try = 1;
/** A finally reached by a throw: `value` is thrown again as control leaves it. */
const HELD_Thrown = 2;
/** A finally reached by a Return, whose value is on the stack: it returns as control leaves it. */
const HELD_Returned = 3;

/** A Try's catch that a throw does not land in. */
export const NO_CATCH = -2;

export class Held {
  constructor(
    readonly kind: number,
    /** The blocks it holds over, from `from` to `to`, excluded. */
    public from: number,
    public to: number,
    /** A finally's thrown value. */
    readonly value: Value = undefined,
  ) {}

  holds(block: number): boolean {
    return this.from <= block && block < this.to;
  }
}

/** A scope: the chain it made, and the chain under it, which it gives back as it comes off. */
class ScopeHeld extends Held {
  constructor(
    from: number,
    to: number,
    readonly chain: Scope,
    readonly below: Scope,
  ) {
    super(HELD_Scope, from, to);
  }
}

/** A Try's handlers, held over its try and catch bodies. */
class TryHeld extends Held {
  constructor(
    from: number,
    /** Where the catch body starts: before it, a throw is the catch's. */
    readonly catchFrom: number,
    /** The finally body's blocks, none where it has none. */
    readonly finallyFrom: number,
    readonly finallyTo: number,
    /** Where a throw lands for the catch, -1 for the region's exit, NO_CATCH for none. */
    readonly catchAt: number,
    /** The catch's variable, or its register. */
    readonly into: string | number,
    /** The operand stack's height as the Try ran, which a throw cuts it back to. */
    readonly height: number,
  ) {
    super(HELD_Try, from, finallyFrom);
  }
}

function heldOf(cx: Activation): Held[] {
  let held = cx.held;
  if (held === null) {
    held = [];
    cx.held = held;
  }

  return held;
}

/** `object` on top of the scope chain, held over the blocks from `from` to `to`. */
function pushScope(cx: Activation, object: Avm1Object, from: number, to: number): void {
  const below = cx.scope;
  cx.scope = new Scope(below, SCOPE_With, object);
  heldOf(cx).push(new ScopeHeld(from, to, cx.scope, below));
}

/**
 * Keeps of `held`, from index `from` up, the entries `keep` says, and the
 * scope chain as the scopes kept make it: the top one's, or with none
 * kept, the chain under the first one taken off.
 */
function keepFrom(cx: Activation, held: Held[], from: number, keep: (h: Held) => boolean): void {
  let n = from;
  let top: Scope | null = null;
  let base: Scope | null = null;
  for (let i = from; i < held.length; i++) {
    const h = held[i];
    if (keep(h)) {
      held[n++] = h;
      if (h instanceof ScopeHeld) {
        top = h.chain;
      }
    } else if (h instanceof ScopeHeld && base === null) {
      base = h.below;
    }
  }

  held.length = n;
  if (top !== null) {
    cx.scope = top;
  } else if (base !== null) {
    cx.scope = base;
  }
}

function cut(st: Value[], height: number): void {
  if (st.length > height) {
    st.length = height;
  }
}

/**
 * With: `value`, a primitive boxed, on the scope chain over the body's
 * blocks; false, the body skipped, for undefined and null, and where the
 * chain holds MAX_SCOPES already (adl).
 */
export function enterWith(
  cx: Activation,
  value: Value,
  from: number,
  to: number,
  version: number,
): boolean {
  if (value === undefined || value === null || cx.scope.depth >= MAX_SCOPES) {
    return false;
  }

  pushScope(cx, cx.realm.box(value, version), from, to);
  return true;
}

/** Try: its handlers, held over its try and catch bodies. */
export function enterTry(
  cx: Activation,
  from: number,
  catchFrom: number,
  finallyFrom: number,
  finallyTo: number,
  catchAt: number,
  into: string | number,
): void {
  heldOf(cx).push(
    new TryHeld(from, catchFrom, finallyFrom, finallyTo, catchAt, into, cx.st.length),
  );
}

/**
 * Where control goes from the block `at`, where `error` was thrown: the
 * catch of the first Try whose try body holds it, its variable set, or the
 * finally of the first whose try or catch body does, which throws the
 * value again as control leaves it. The stack is cut back to its height
 * as that Try ran. Another error, a bug's or the host's, a recursion
 * limit's, passes through, as does a value no Try catches.
 */
export function caught(cx: Activation, error: unknown, at: number): number {
  const held = cx.held;
  if (!(error instanceof Avm1Throw) || held === null) {
    throw error;
  }

  cx.into = -1;
  for (let i = held.length - 1; i >= 0; i--) {
    const h = held[i];
    if (!(h instanceof TryHeld) || !h.holds(at)) {
      continue;
    }

    if (at < h.catchFrom && h.catchAt !== NO_CATCH) {
      // The scopes that hold where it was thrown hold over the catch body
      // too, under its variable's (adl).
      const from = h.catchFrom;
      const to = h.finallyFrom;
      keepFrom(cx, held, i + 1, (s) => s instanceof ScopeHeld && s.holds(at));
      for (let j = i + 1; j < held.length; j++) {
        held[j].from = from;
        held[j].to = to;
      }

      cut(cx.st, h.height);
      const into = h.into;
      if (typeof into === "number") {
        cx.into = into;
        cx.thrown = error.value;
      } else {
        const scope = new Avm1Object();
        scope.add(into, error.value, 0);
        pushScope(cx, scope, from, to);
      }

      return h.catchAt;
    }

    if (h.finallyFrom < h.finallyTo) {
      keepFrom(cx, held, i, () => false);
      cut(cx.st, h.height);
      held.push(new Held(HELD_Thrown, h.finallyFrom, h.finallyTo, error.value));
      return h.finallyFrom;
    }
  }

  throw error;
}

/**
 * Control going to block `to` (-1: the exit) across the bounds of a body:
 * the Trys that do not hold over it come off, and a finally that a throw
 * or a Return reached throws or returns as control leaves it, even by a
 * jump. Scopes come off after the first action there (V.scopes).
 */
export function leave(cx: Activation, to: number): number {
  const held = cx.held;
  if (held !== null) {
    for (let i = held.length - 1; i >= 0; i--) {
      const h = held[i];
      if (h.holds(to)) {
        break;
      }

      if (h.kind === HELD_Scope) {
        continue;
      }

      held.splice(i, 1);
      if (h.kind === HELD_Thrown) {
        throw new Avm1Throw(h.value);
      }

      if (h.kind === HELD_Returned) {
        return returned(cx);
      }
    }
  }

  if (to < 0) {
    cx.ret = undefined;
  }

  return to;
}

/** The scopes that do not hold over block `at`, where control is, come off. */
export function scopes(cx: Activation, at: number): void {
  const held = cx.held;
  if (held === null) {
    return;
  }

  let n = held.length;
  while (n > 0 && held[n - 1].kind === HELD_Scope && !held[n - 1].holds(at)) {
    n--;
  }

  if (n < held.length) {
    keepFrom(cx, held, n, () => false);
  }
}

/**
 * Return, its value on top of the stack: the finally of the first Try
 * whose try or catch body holds control runs first, the stack cut back to
 * its height as that Try ran with the value left on top, and the value is
 * popped as control leaves it, the stack's top then (adl); a finally's own
 * throw or Return gives way to this one.
 */
export function returned(cx: Activation): number {
  const held = cx.held;
  if (held !== null) {
    for (let i = held.length - 1; i >= 0; i--) {
      const h = held[i];
      if (h instanceof TryHeld && h.finallyFrom < h.finallyTo) {
        const st = cx.st;
        const value = st.pop();
        cut(st, h.height);
        st.push(value);
        keepFrom(cx, held, i, () => false);
        held.push(new Held(HELD_Returned, h.finallyFrom, h.finallyTo));
        return h.finallyFrom;
      }
    }
  }

  cx.ret = cx.st.pop();
  return -1;
}
