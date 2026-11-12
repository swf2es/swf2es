// Runtime.prop, setProp and callProp: the lookups natives made by
// publicName, with the names and values checked against the classes'
// declarations by `pnpm typecheck`, where each @ts-expect-error below must
// be an error.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import {
  type BuiltinClasses,
  createRuntime,
  type Ref,
  type Runtime,
  type RuntimeOptions,
} from "@swf2es/runtime/avm2";
import { runShell } from "../../../packages/cli/dist/index.js";
import type { As3 } from "../../../packages/player/dist/as3/types.js";

const generated = fileURLToPath(new URL("../../../oracle/avmplus/generated/", import.meta.url));
const skip = !existsSync(`${generated}builtin.abc`) && "oracle/avmplus missing";

/** A runtime with avmshell's builtins, their toplevel script run. */
async function builtinRuntime(): Promise<Runtime> {
  const wasm = readFileSync(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
  const compiler = await createCodegen(await WebAssembly.compile(wasm));
  const libraries = [
    { name: "builtin", abc: new Uint8Array(readFileSync(`${generated}builtin.abc`)) },
  ];
  let rt: Runtime | null = null;
  await runShell(libraries, [], {
    compiler,
    createRuntime: (options: RuntimeOptions) => {
      rt = createRuntime(options);
      return rt;
    },
    print: () => {},
  });

  return rt as unknown as Runtime;
}

test("prop, setProp and callProp reach what publicName's lookups reach", { skip }, async () => {
  const rt = await builtinRuntime();
  const o = rt.construct(rt.classNamed("Error"), "boom", 7);
  const e = o as Ref<BuiltinClasses["Error"]>;

  assert.equal(rt.prop(e, "message"), "boom");
  assert.equal(rt.prop(e, "errorID"), 7);
  assert.equal(rt.prop(e, "errorID"), rt.getProperty(o, rt.publicName("errorID")));

  rt.setProp(e, "message", "bang");
  assert.equal(rt.getProperty(o, rt.publicName("message")), "bang");

  assert.equal(rt.callProp(e, "getStackTrace"), rt.callProperty(o, rt.publicName("getStackTrace")));

  const array = rt.array([3, 1, 2]) as Ref<BuiltinClasses["Array"]>;
  assert.equal(rt.prop(array, "length"), 3);
  rt.setProp(array, "length", 1);
  assert.equal(rt.prop(array, "length"), 1);
});

/** Never run: what the compiler must refuse. */
export function refused(
  rt: Runtime,
  e: Ref<BuiltinClasses["Error"]>,
  r: As3<"flash.geom::Rectangle">,
) {
  const width: number = rt.prop(r, "width");
  const points: number = rt.prop(r, "x") + rt.prop(r, "y") + width;
  rt.setProp(r, "height", points);

  // @ts-expect-error: a name the class does not declare
  rt.prop(r, "widht");
  // @ts-expect-error: a Number property set to a String
  rt.setProp(r, "x", "1");
  // @ts-expect-error: errorID has a getter alone
  rt.setProp(e, "errorID", 1);
  // @ts-expect-error: a method is called, not read
  rt.prop(e, "getStackTrace");
  // @ts-expect-error: a property is read, not called
  rt.callProp(r, "width");
  // @ts-expect-error: contains takes two Numbers
  rt.callProp(r, "contains", 1);
  // @ts-expect-error: an object of no declared class
  rt.prop({} as unknown, "width");
  // @ts-expect-error: no class of that name
  const missing: As3<"flash.geom::Rectangel"> | null = null;

  return missing;
}
