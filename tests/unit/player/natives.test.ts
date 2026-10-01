// registerNativeClass: the keys a class's members register under, that each
// runs with the AS3 object as `this`, and that two factories' classes stay
// apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { avm2 } from "@swf2es/runtime";
import { registerNativeClass } from "../../../packages/player/dist/playerglobal/natives.js";

/** A natives record's handler for `key`, bound as the runtime binds one. */
function handler(natives: avm2.Natives, key: string): avm2.Method {
  const make = natives[key];
  assert.ok(make, `no native ${key}`);
  return make(null as unknown as avm2.Runtime);
}

test("members register under the compiler's names, by kind", () => {
  const natives: avm2.Natives = {};
  let got = "";
  class Probe {
    declare $display: { name: string };

    get name(): string {
      return this.$display.name;
    }

    set name(v: unknown) {
      this.$display.name = String(v);
    }

    get only(): number {
      return 1;
    }

    poke(v: unknown): string {
      got = `${this.$display.name}:${String(v)}`;
      return got;
    }

    static get version(): number {
      return 2;
    }

    static make(v: unknown): string {
      return `made ${String(v)}`;
    }
  }

  registerNativeClass(natives, "pkg::Probe", Probe);
  assert.deepEqual(Object.keys(natives).sort(), [
    "pkg::Probe#get:name",
    "pkg::Probe#get:only",
    "pkg::Probe#poke",
    "pkg::Probe#set:name",
    "pkg::Probe.get:version",
    "pkg::Probe.make",
  ]);

  // Each runs with the AS3 object as `this`, never an instance of the class.
  const o = { $display: { name: "a" } };
  assert.equal(handler(natives, "pkg::Probe#get:name").call(o), "a");
  handler(natives, "pkg::Probe#set:name").call(o, 7);
  assert.equal(o.$display.name, "7");
  assert.equal(handler(natives, "pkg::Probe#poke").call(o, "x"), "7:x");
  assert.equal(got, "7:x");
  assert.equal(handler(natives, "pkg::Probe.get:version").call(null), 2);
  assert.equal(handler(natives, "pkg::Probe.make").call(null, 3), "made 3");
});

test("reading the descriptors runs no getter", () => {
  const natives: avm2.Natives = {};
  class Loud {
    get boom(): never {
      throw new Error("read");
    }
  }

  registerNativeClass(natives, "Loud", Loud);
  assert.ok(natives["Loud#get:boom"]);
});

test("two factories' classes close over their own context", () => {
  const make = (tag: string) => {
    const natives: avm2.Natives = {};
    class Tagged {
      get tag(): string {
        return tag;
      }
    }

    registerNativeClass(natives, "Tagged", Tagged);
    return natives;
  };
  const a = make("a");
  const b = make("b");
  assert.equal(handler(a, "Tagged#get:tag").call({}), "a");
  assert.equal(handler(b, "Tagged#get:tag").call({}), "b");
  assert.notEqual(a["Tagged#get:tag"], b["Tagged#get:tag"]);
});
