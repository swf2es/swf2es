// GetURL and GetURL2 as the runtime routes them to its host, as Ruffle's
// action_get_url and action_get_url_2 do: fscommand, loads into levels and
// clips, and pages to open with the scope's variables.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Host, Runtime, set } from "../../../packages/runtime/dist/avm1/index.js";

function routed(version = 6) {
  const rt = new Runtime();
  const V = rt.version(version);
  const calls: unknown[][] = [];
  const root = {};
  const rootObject = rt.newObject();
  const host: Host = {
    trace: (text) => calls.push(["trace", text]),
    play: () => {},
    stop: () => {},
    halt: () => {},
    root: () => rootObject,
    level: (n) => (n === 0 ? rootObject : undefined),
    clipOf: (o) => (o === rootObject ? root : undefined),
    fsCommand: (command, args) => calls.push(["fsCommand", command, args]),
    navigate: (url, window, form) => calls.push(["navigate", url, window, form]),
    loadMovie: (into, url, form) => calls.push(["loadMovie", into, url, form]),
    loadVariables: (into, url, form) => calls.push(["loadVariables", into, url, form]),
  };
  const cx = rt.activation([], [], root, rootObject, host);
  return { rt, V, cx, calls, root, rootObject };
}

test("an FSCommand: URL in any case is fscommand, the target its arguments", () => {
  const { V, cx, calls } = routed();
  V.getUrl(cx, "FSCommand:quit", "");
  V.getUrl(cx, "fscommand:Show", "a b");
  V.getUrl2(cx, "1", "FSCOMMAND:trapallkeys", 0);
  V.getUrl2(cx, "x", "fscommand:", 0x40);

  assert.deepEqual(calls, [
    ["fsCommand", "quit", ""],
    ["fsCommand", "Show", "a b"],
    ["fsCommand", "trapallkeys", "1"],
    ["fsCommand", "", "x"],
  ]);
});

test("GetURL opens a page, blank in any spelling as _blank, or loads into the level it names", () => {
  const { V, cx, calls } = routed();
  V.getUrl(cx, "http://a/", "BLANK");
  V.getUrl(cx, "http://a/", "_Blank");
  V.getUrl(cx, "http://a/", "self");
  V.getUrl(cx, "x.swf", "_level2");
  V.getUrl(cx, "", "_level1");
  // Not a level's number: nothing, fscommand or not.
  V.getUrl(cx, "x.swf", "_levelx");
  V.getUrl(cx, "FSCommand:quit", "_level2.5");

  assert.deepEqual(calls, [
    ["navigate", "http://a/", "_blank", null],
    ["navigate", "http://a/", "_blank", null],
    ["navigate", "http://a/", "self", null],
    ["loadMovie", 2, "x.swf", null],
    ["loadMovie", 1, "", null],
  ]);
});

test("GetURL2 routes by its flags, and a method sends the scope's variables", () => {
  const { V, cx, calls, root, rootObject } = routed();
  set(rootObject, "b", 2, 6);
  set(rootObject, "a", "x y", 6);
  const form = (method: string) => ({
    method,
    vars: [
      ["a", "x y"],
      ["b", "2"],
    ],
  });

  // getURL, with and without a method.
  V.getUrl2(cx, "_self", "http://b/", 0);
  V.getUrl2(cx, "_blank", "http://c/", 2);
  V.getUrl2(cx, "w", "http://d/", 1);
  // loadMovieNum: into the level, never with variables.
  V.getUrl2(cx, "_level3", "y.swf", 1);
  V.getUrl2(cx, "_level2.9", "y.swf", 0);
  // loadMovie into a level that is there, and unloadMovie.
  V.getUrl2(cx, "_level0", "z.swf", 0x40 | 1);
  V.getUrl2(cx, "_level", "", 0x40);
  // loadVariablesNum, and loadVariables named by a path that is no clip: a page after all.
  V.getUrl2(cx, "_level0", "v.txt", 0x80 | 2);
  V.getUrl2(cx, "_blank", "v.txt", 0x80);
  // loadVariables into the root by its object.
  V.getUrl2(cx, rootObject, "v.txt", 0x80);

  assert.deepEqual(calls, [
    ["navigate", "http://b/", "_self", null],
    ["navigate", "http://c/", "_blank", form("POST")],
    ["navigate", "http://d/", "w", form("GET")],
    ["loadMovie", 3, "y.swf", null],
    ["loadMovie", 2, "y.swf", null],
    ["loadMovie", root, "z.swf", form("GET")],
    ["loadMovie", root, "", null],
    ["loadVariables", root, "v.txt", form("POST")],
    ["navigate", "v.txt", "_blank", null],
    ["loadVariables", root, "v.txt", null],
  ]);
});

test("GetURL2 converts its target before its URL", () => {
  const { rt, V, cx, calls } = routed();
  const logged = (name: string) => {
    const o = rt.newObject();
    set(
      o,
      "toString",
      rt.realm.method(() => {
        calls.push(["toString", name]);
        return name;
      }),
      6,
    );
    return o;
  };
  V.getUrl2(cx, logged("_blank"), logged("http://e/"), 0);

  assert.deepEqual(calls, [
    ["toString", "_blank"],
    ["toString", "http://e/"],
    ["navigate", "http://e/", "_blank", null],
  ]);
});
