// How a module is evaluated where the engine's frames name no Function's
// code by its sourceURL, as JavaScriptCore's do, emulated here with V8's
// prepareStackTrace: as a script, in a document; and where its scripts do
// not run, as in a DOM that loads them without running them, by a
// Function after one try, which gives a source's own error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../../../../packages/player/dist/scripting/evaluate.js";

const prepare = Error.prepareStackTrace;
Error.prepareStackTrace = (_error, sites) =>
  sites
    .map((site) => {
      const at = site.isEval()
        ? ""
        : `${site.getScriptNameOrSourceURL()}:${site.getLineNumber()}:${site.getColumnNumber()}`;
      return `${site.getFunctionName() ?? ""}@${at}`;
    })
    .join("\n");

// A document whose scripts load, one turn later, but never run.
let appended = 0;
const element = () => {
  const script = {
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    src: "",
    remove() {},
  };
  return script;
};
(globalThis as { document?: unknown }).document = {
  head: {
    append(script: { onload: () => void }) {
      appended++;
      setTimeout(() => script.onload(), 0);
    },
  },
  createElement: element,
};

test("a module whose script does not run is evaluated by a Function, and the next at once", async (t) => {
  t.after(() => {
    Error.prepareStackTrace = prepare;
    delete (globalThis as { document?: unknown }).document;
  });

  const module = "export default function (rt) { return 1 + rt; }";
  const first = evaluate(module, "swf2es-1.js");
  const second = evaluate(module, "swf2es-2.js");
  assert.ok(first instanceof Promise);
  assert.ok(second instanceof Promise);

  // The second waited for the first, so one script was tried.
  const [a, b] = await Promise.all([first, second]);
  assert.equal(appended, 1);
  assert.equal(a.script, "swf2es-1.js");
  assert.equal(b.script, "swf2es-2.js");
  assert.equal(a.factory(2 as never), 3);

  // Scripts are refused now: a Function at once, its error the source's.
  const third = evaluate(module, "swf2es-3.js");
  assert.ok(!(third instanceof Promise));
  assert.throws(() => evaluate("export default function (rt) { +; }", "swf2es-4.js"), SyntaxError);
  assert.equal(appended, 1);
});
