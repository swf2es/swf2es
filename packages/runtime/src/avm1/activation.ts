// What a region of AVM1 code runs in (docs/avm1.md, "Compiling"): a block's
// or a function's activation.
import type { Held } from "./control.js";
import type { Host, Target } from "./host.js";
import type { Avm1Function, Avm1Object, LazyLocals, Property } from "./objects.js";
import type { Realm } from "./realm.js";
import type { Scope } from "./scope.js";
import type { Value } from "./values.js";

/** A region of a block, the block's own code or a function's body, which gives what it returns. */
export type Region = (cx: Activation, self?: Value, args?: Value[]) => Value;

/** What the factory of a SWF's module gives: by block, its regions, its own code first. */
export type Blocks = Region[][];

/** A function's `arguments`, made as its activation object is first asked for it. */
export const PENDING_Arguments = 1;
/** A function's `super`, likewise. */
export const PENDING_Super = 2;

/**
 * What a region runs in: the operand stack, the constant pool, the target
 * and the host. Flash has one operand stack, not one an activation: every
 * activation of a frame's actions shares the frame's, which the player
 * empties between frames, and a function's shares its caller's.
 */
export class Activation implements LazyLocals {
  /** The block's regions, which DefineFunction makes functions of. */
  code: Region[] = [];
  /** The function running, null in a block: `arguments.callee`, and its callees' caller. */
  callee: Avm1Function | null = null;
  /** The function that called it, null from a block: `arguments.caller`. */
  caller: Avm1Function | null = null;
  /** The arguments it was called with. */
  args: Value[] = NO_ARGS;
  /** How far up `this`'s prototypes the function was found, which `super` starts from. */
  depth = 0;
  /** The `this` it was called with, which `super` is made of. */
  receiver: Value = undefined;
  /** What of `arguments` and `super` its activation object has yet to make (PENDING_ bits). */
  pending = 0;
  /** The movie's four global registers. */
  readonly g: Value[];
  /** What its Withs and Trys hold while control stays in their bodies (control.ts), the latest last. */
  held: Held[] | null = null;
  /** What the region returns where control goes to its exit through a Try (control.ts). */
  ret: Value = undefined;
  /** The register a catch just took a value into, -1 for none, and the value, which the region sets. */
  into = -1;
  thrown: Value = undefined;

  /**
   * The clip timeline actions act on, which SetTarget changes; null where
   * a SetTarget found none, where they do nothing.
   */
  target: Target | null;

  constructor(
    /** The operand stack, the frame's. */
    public st: Value[],
    /** The constant pool the region reads where the compiler cannot tell which: see V.constantPool. */
    public pool: Value[],
    /** The clip whose code runs, the target a SetTarget of "" gives back. */
    readonly base: Target,
    public host: Host,
    readonly realm: Realm,
    /** The scope chain, searched from here down to `_global`. */
    public scope: Scope,
    /** `this`. */
    public self: Value,
    /**
     * The target's AVM1 object, the root's where SetTarget found none: a
     * function called by name without an object takes it as `this`.
     */
    public clip: Avm1Object,
  ) {
    this.target = base;
    this.g = realm.registers;
  }

  get global(): Avm1Object {
    return this.realm.global;
  }

  /** `arguments` or `super`, made on the activation object `o` as it is first asked for. */
  local(o: Avm1Object, name: string, version: number): Property | undefined {
    return this.realm.pendingLocal(this, o, name, version);
  }
}

const NO_ARGS: Value[] = [];
