// The desktop app's --flashvars and --param, read as a page's <object> or
// <embed> gave them to Flash, the base they name resolved against the SWF,
// and only the element's own parameters reaching it; a second start's
// arguments as it sent them, and the launcher keeping the switches' values.
import assert from "node:assert/strict";
import { test } from "node:test";
import { electronArguments } from "../../apps/desktop/src/launch/arguments.ts";
import { airCommand } from "../../apps/desktop/src/main/air.ts";
import {
  embeddingArguments,
  embeddingFor,
  exactArguments,
  settleEmbedding,
} from "../../apps/desktop/src/main/embedding.ts";
import { embeddingAttributes } from "../../apps/desktop/src/shared/embedding.ts";

test("FlashVars from both forms, joined in order", () => {
  const read = embeddingArguments([
    "electron",
    "--flashvars",
    "a=1&b=two%20words",
    "--flashvars=c=3",
    "--param",
    "FlashVars=d=4",
    "movie.swf",
  ]);
  assert.deepEqual(read.params, { flashvars: "a=1&b=two%20words&c=3&d=4" });
  assert.deepEqual(read.rest, ["electron", "movie.swf"]);
  assert.deepEqual(read.warnings, []);
});

test("parameters by any case, the last of a name winning, their values kept", () => {
  const read = embeddingArguments([
    "--param",
    "quality=low",
    "--param=Scale=noScale",
    "--param",
    "salign=TL",
    "--param=QUALITY=best",
    "--param",
    "bgcolor=#ff0000",
    "--param=menu=false",
    "--param",
    "wmode=opaque",
    "--param",
    "base=https://example.com/a=b/",
    "--param",
    "allowNetworking=internal",
    "--trace",
    "movie.swf",
  ]);
  assert.deepEqual(read.params, {
    quality: "best",
    scale: "noScale",
    salign: "TL",
    bgcolor: "#ff0000",
    menu: "false",
    wmode: "opaque",
    base: "https://example.com/a=b/",
    allownetworking: "internal",
  });
  assert.deepEqual(read.rest, ["--trace", "movie.swf"]);
  assert.deepEqual(read.warnings, []);
});

test("what does nothing here, or is no parameter, is said and left out", () => {
  const read = embeddingArguments([
    "--param",
    "allowScriptAccess=always",
    "--param",
    "allowScriptAccess=never",
    "--param",
    "allowFullScreen=true",
    "--param",
    "movie=other.swf",
    "--param",
    "loop=false",
    "--param",
    "noequals",
    "--param",
    "=value",
    "movie.swf",
    "--flashvars",
  ]);
  assert.deepEqual(read.params, {});
  assert.deepEqual(read.rest, ["movie.swf"]);
  assert.deepEqual(read.warnings, [
    "--param allowscriptaccess: ignored, ExternalInterface stays off in the desktop app",
    "--param allowfullscreen: ignored, a SWF's full screen is the window's here, always allowed, as in Flash's projector",
    "--param movie: ignored, name the SWF on the command line",
    "--param loop: no such parameter",
    "--param noequals: not name=value",
    "--param =value: not name=value",
    "--flashvars needs a value (--flashvars=... for one that starts with -)",
  ]);
});

test("an empty FlashVars sets none; an AIR application's arguments are its own", () => {
  assert.deepEqual(embeddingArguments(["--flashvars="]).params, {});
  const read = embeddingArguments(["app.xml", "--", "--flashvars", "a=1", "--param", "x=y"]);
  assert.deepEqual(read.params, {});
  assert.deepEqual(read.rest, ["app.xml", "--", "--flashvars", "a=1", "--param", "x=y"]);
  assert.deepEqual(read.warnings, []);
});

test("a switch's value is never the movie nor a descriptor", () => {
  // A value ending in .xml would otherwise run an AIR application.
  assert.equal(airCommand(["--flashvars", "config=settings.xml", "movie.swf"], "/"), null);
  assert.deepEqual(
    embeddingArguments(["--flashvars", "https://example.com/other.swf", "movie.swf"]).rest,
    ["movie.swf"],
  );
});

test("a value apart from its switch never starts with -, which other switches would read", () => {
  const read = embeddingArguments([
    "--flashvars",
    "--proxy=socks5://h:1",
    "--param",
    "--trace",
    "m.swf",
  ]);
  assert.deepEqual(read.params, {});
  assert.deepEqual(read.rest, ["--proxy=socks5://h:1", "--trace", "m.swf"]);
  assert.deepEqual(read.warnings, [
    "--flashvars needs a value (--flashvars=... for one that starts with -)",
    "--param needs a value (--param=... for one that starts with -)",
  ]);
  assert.deepEqual(embeddingArguments(["--flashvars=-x=1"]).params, { flashvars: "-x=1" });
});

test("only the element's parameters reach it, whatever the page is sent", () => {
  const read = embeddingArguments([
    "--param=workers=true",
    "--param=width=100%",
    "--param=id=player",
    "--param=unmutePrompt=false",
    "--param=quality=low",
  ]);
  assert.deepEqual(read.params, { quality: "low" });
  assert.deepEqual(read.warnings, [
    "--param workers: no such parameter",
    "--param width: no such parameter",
    "--param id: no such parameter",
    "--param unmuteprompt: no such parameter",
  ]);
  // The page's own filter, for whatever the main process sends.
  assert.deepEqual(
    embeddingAttributes({
      allowscriptaccess: "always",
      workers: "true",
      width: "100%",
      src: "other.swf",
      id: "x",
      toString: "x",
      flashvars: "a=1",
      menu: "false",
    }),
    [
      ["flashvars", "a=1"],
      ["menu", "false"],
    ],
  );
  assert.deepEqual(embeddingAttributes(undefined), []);
  assert.deepEqual(embeddingAttributes(Object.create({ quality: "low" })), []);
});

test("settled once: base an http or https URL, or below a local SWF's directory", () => {
  const local = "/home/user/games/movie.swf";
  const remote = "https://example.com/games/movie.swf?a=1";
  const settle = (base: string, movie: string | null) =>
    settleEmbedding({ base, menu: "false" }, movie, false);
  for (const [base, movie] of [
    ["assets/", local],
    ["./sub/deeper/", local],
    ["a/../b/", local],
    ["http://cdn.test/x/", local],
    ["https://cdn.test/x/", remote],
    ["../shared/", remote],
    ["/cdn/", remote],
    ["//cdn.test/", remote],
  ]) {
    assert.deepEqual(settle(base, movie), { params: { base, menu: "false" }, warnings: [] }, base);
  }

  for (const [base, movie, why] of [
    ["../", local, "outside the SWF's directory"],
    ["sub/../../x/", local, "outside the SWF's directory"],
    ["/etc/", local, "outside the SWF's directory"],
    ["//other/", local, "outside the SWF's directory"],
    ["file:///etc/", local, "not an http, https or relative URL"],
    ["swf2es://app/", remote, "not an http, https or relative URL"],
    ["swf2es://file/0123456789abcdef/", local, "not an http, https or relative URL"],
    ["javascript:alert(1)", remote, "not an http, https or relative URL"],
  ]) {
    const settled = settle(base, movie);
    assert.deepEqual(settled.params, { menu: "false" }, base);
    assert.equal(settled.warnings.length, 1);
    assert.match(settled.warnings[0], new RegExp(`^--param base=.*: ${why}[^;]*; left out$`), base);
  }

  // Nothing named to play: nothing to say yet.
  assert.deepEqual(settle("../", null), { params: { base: "../", menu: "false" }, warnings: [] });
  // An AIR application gets none, and is told so.
  assert.deepEqual(settleEmbedding({ quality: "low" }, null, true), {
    params: {},
    warnings: ["--flashvars and --param: ignored for an AIR application, which has no page"],
  });
  assert.deepEqual(settleEmbedding({}, null, true), { params: {}, warnings: [] });
});

test("base resolved against the SWF's URL as it plays", () => {
  const local = "swf2es://file/0123456789abcdef/movie.swf";
  const remote = "https://example.com/games/movie.swf?a=1";
  assert.deepEqual(embeddingFor({ quality: "low" }, local), { quality: "low" });
  assert.deepEqual(embeddingFor({ base: "assets/" }, local), {
    base: "swf2es://file/0123456789abcdef/assets/",
  });
  assert.deepEqual(embeddingFor({ base: "." }, remote), { base: "https://example.com/games/" });
  assert.deepEqual(embeddingFor({ base: "http://cdn.test/x/", scale: "noScale" }, local), {
    base: "http://cdn.test/x/",
    scale: "noScale",
  });
  assert.deepEqual(embeddingFor({ base: "file:///etc/", menu: "false" }, local), {
    menu: "false",
  });
});

test("a second start's arguments as it sent them, else Electron's", () => {
  const given = ["electron", "--param", "m.swf", "quality=low"];
  const sent = ["electron", "--param", "quality=low", "m.swf"];
  assert.deepEqual(exactArguments({ argv: sent }, given), sent);
  assert.deepEqual(exactArguments(undefined, given), given);
  assert.deepEqual(exactArguments(null, given), given);
  assert.deepEqual(exactArguments({}, given), given);
  assert.deepEqual(exactArguments({ argv: "m.swf" }, given), given);
  assert.deepEqual(exactArguments({ argv: ["m.swf", 1] }, given), given);
});

test("the launcher keeps the switches' values, and resolves paths alone", () => {
  assert.deepEqual(
    electronArguments(
      [
        "--flashvars",
        "a=1&b=2",
        "--PARAM",
        "base=assets/",
        "--param=quality=low",
        "--trace",
        "movie.swf",
        "https://example.com/m.swf",
        "app.xml",
        "--",
        "arg",
        "--flashvars",
        "x",
      ],
      "/cwd",
    ),
    [
      "--flashvars",
      "a=1&b=2",
      "--PARAM",
      "base=assets/",
      "--param=quality=low",
      "--trace",
      "/cwd/movie.swf",
      "https://example.com/m.swf",
      "/cwd/app.xml",
      "--",
      "arg",
      "--flashvars",
      "x",
    ],
  );
});
