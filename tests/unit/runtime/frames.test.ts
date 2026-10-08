// The scripts stack frames name, by which Runtime.codeDomain tells whose
// code runs, in each engine's format: JavaScriptCore names no script for
// code a Function made, whatever its sourceURL, and its frames must count
// as no script's, not as the next frame's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { avm2 } from "@swf2es/runtime";

const runtimeDist = new URL("../../../packages/runtime/dist/avm2/", import.meta.url);

// As MiniBrowser (WebKitGTK 2.50) gave them: a Function's code with a
// sourceURL, a classic script's from a Blob URL, and native code.
const jsc = [
  "$abc@",
  "factory@",
  "append@[native code]",
  "load@blob:http://127.0.0.1:8791/0169dde3-46a5-4256-8b49-383c576365ab:1:88",
  "features@http://127.0.0.1:8769/bench/driver.js:84:32",
  "global code@http://127.0.0.1:8769/bench/driver.js:1:21",
].join("\n");

test("JavaScriptCore's frames: a Function's and native code's name no script", () => {
  assert.deepEqual(avm2.stackFrames(jsc), [
    null,
    null,
    null,
    "blob:http://127.0.0.1:8791/0169dde3-46a5-4256-8b49-383c576365ab",
    "http://127.0.0.1:8769/bench/driver.js",
    "http://127.0.0.1:8769/bench/driver.js",
  ]);
  assert.deepEqual(avm2.frameScripts(jsc), [
    "blob:http://127.0.0.1:8791/0169dde3-46a5-4256-8b49-383c576365ab",
    "http://127.0.0.1:8769/bench/driver.js",
    "http://127.0.0.1:8769/bench/driver.js",
  ]);
});

test("V8's frames: its heading is no frame, an anonymous function's names its script", () => {
  const v8 = [
    "Error",
    "    at Runtime.abc (http://127.0.0.1:1/runtime.js:10:5)",
    "    at swf2es-3.js:2:9",
    "    at eval (swf2es-4.js:2:9)",
    "    at new Promise (<anonymous>)",
  ].join("\n");

  assert.deepEqual(avm2.stackFrames(v8), [
    "http://127.0.0.1:1/runtime.js",
    "swf2es-3.js",
    "swf2es-4.js",
    null,
  ]);
});

test("SpiderMonkey's frames", () => {
  const sm = ["abc@http://127.0.0.1:1/runtime.js:10:5", "factory@swf2es-3.js:2:9", ""].join("\n");

  assert.deepEqual(avm2.stackFrames(sm), ["http://127.0.0.1:1/runtime.js", "swf2es-3.js"]);
});

test("the runtime calls a SWF's functions, and its own that do, in no tail position", () => {
  // JavaScriptCore makes a strict `return f(...)` a proper tail call, which
  // drops the caller's frame: a function value the runtime called would
  // then seem called by the SWF code that called the runtime, to anything
  // that reads the stack. node keeps every frame, so the source is what
  // can be checked here.
  const tail =
    /return\s+(?:\(?[\w$.[\]\s]*?(?:\)\s*)?\.(?:apply|call)|(?:this|rt)\.(?:call\w*|enter))\(/;
  const proto = avm2.Runtime.prototype as unknown as Record<string, () => unknown>;
  for (const name of [
    "getProperty",
    "getBound",
    "methodClosure",
    "callProperty",
    "callPropLex",
    "call",
    "callValue",
    "enter",
    "callInterface",
    "callSuper",
    "callBound",
  ]) {
    assert.doesNotMatch(String(proto[name]), tail, name);
  }

  // Function's call and apply, and a Proxy's flash_proxy methods.
  for (const file of ["object.js", "proxy.js"]) {
    const source = readFileSync(new URL(`natives/${file}`, runtimeDist), "utf8");
    assert.doesNotMatch(source, /return\s+rt\.call\w*\(/, file);
  }

  assert.match("return f.apply(o, args);", tail);
  assert.match("return (e.get as Method).call(o);", tail);
  assert.match("return this.callValue(f, receiver, args, null);", tail);
  assert.doesNotMatch("r = f.apply(o, args);\n    return r;", tail);
});
