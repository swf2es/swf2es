// What a SWF's AVM1 module calls (docs/avm1.md, "Compiling"): its factory
// takes the runtime, asks it for the operations of the SWF's version,
// `V`, once, and each region of each block takes its activation, `cx`.
import type { Host, Target } from "./host.js";
import { stringOf, toBoolean, type Value } from "./values.js";

/**
 * What a region runs in: the operand stack, the constant pool, the target
 * and the host. Flash has one operand stack, not one an activation: every
 * activation of a frame's actions shares the frame's, which the player
 * empties between frames.
 */
export class Activation {
  constructor(
    /** The operand stack, the frame's. */
    public st: Value[],
    /** The constant pool the region reads where the compiler cannot tell which: see V.constantPool. */
    public pool: Value[],
    /** The clip timeline actions act on. */
    public target: Target,
    public host: Host,
  ) {}
}

/** A region of a block, the block's own code or a function's body. */
export type Region = (cx: Activation) => void;

/** What the factory of a SWF's module gives: by block, its regions, its own code first. */
export type Blocks = Region[][];

/** A module's default export. */
export type Factory = (rt: Runtime) => Blocks;

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

/** The operations of a version, `V`: the module's code calls these, never testing its version. */
export interface Operations {
  readonly version: number;
  /** ConstantPool: the activation's pool from here on, which a frame's later blocks start with. */
  constantPool(cx: Activation, pool: Value[]): void;
  trace(cx: Activation, value: Value): void;
  toBoolean(value: Value): boolean;
  toString(value: Value): string;
  play(cx: Activation): void;
  stop(cx: Activation): void;
  /** An action Flash cannot read: the SWF stops there. */
  halt(cx: Activation): never;
  /** A block larger than the compiler takes. */
  tooLarge(): never;
  /** An action the runtime does not do yet. */
  notYet(name: string): never;
}

function operations(version: number): Operations {
  return {
    version,
    constantPool(cx, pool) {
      cx.pool = pool;
    },
    // undefined traces as "undefined" whatever the version, which converts it to "" up to SWF 6;
    // a carriage return breaks the line, as Flash's log writes it.
    trace(cx, value) {
      const text = value === undefined ? "undefined" : stringOf(value, version);
      cx.host.trace(text.replaceAll("\r", "\n"));
    },
    toBoolean: (value) => toBoolean(value, version),
    toString: (value) => stringOf(value, version),
    play(cx) {
      cx.host.play(cx.target);
    },
    stop(cx) {
      cx.host.stop(cx.target);
    },
    halt(cx) {
      cx.host.halt();
      throw new Halt("the SWF stopped at an action Flash cannot read");
    },
    tooLarge() {
      throw new Error("an AVM1 block too large to compile");
    },
    notYet(name) {
      throw new NotYet(name);
    },
  };
}

/** The operations of each version asked for, made once and shared by every runtime. */
const versions = new Map<number, Operations>();

/** A player's AVM1 runtime, which its SWFs' modules are loaded into. */
export class Runtime {
  /** The operations of SWF version `version`. */
  version(version: number): Operations {
    let ops = versions.get(version);
    if (!ops) {
      ops = operations(version);
      versions.set(version, ops);
    }

    return ops;
  }
}
