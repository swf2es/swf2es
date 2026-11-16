// The desktop app's --flashvars and --param, read as a page's <object> or
// <embed> gave them to Flash, and the base they name resolved against the SWF.
import assert from "node:assert/strict";
import { test } from "node:test";
import { airCommand } from "../../apps/desktop/src/main/air.ts";
import { embeddingArguments, embeddingFor } from "../../apps/desktop/src/main/embedding.ts";

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
    "--flashvars needs a value",
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

test("base is resolved against the SWF, and only to http, https or its own files", () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  const local = "swf2es://file/0123456789abcdef/movie.swf";
  const remote = "https://example.com/games/movie.swf?a=1";
  assert.deepEqual(embeddingFor({ quality: "low" }, local, warn), { quality: "low" });
  assert.deepEqual(embeddingFor({ base: "assets/" }, local, warn), {
    base: "swf2es://file/0123456789abcdef/assets/",
  });
  assert.deepEqual(embeddingFor({ base: "." }, remote, warn), {
    base: "https://example.com/games/",
  });
  assert.deepEqual(embeddingFor({ base: "/cdn/" }, remote, warn), {
    base: "https://example.com/cdn/",
  });
  assert.deepEqual(embeddingFor({ base: "http://cdn.test/x/", scale: "noScale" }, local, warn), {
    base: "http://cdn.test/x/",
    scale: "noScale",
  });
  assert.deepEqual(warnings, []);

  assert.deepEqual(embeddingFor({ base: "file:///etc/", menu: "false" }, local, warn), {
    menu: "false",
  });
  assert.deepEqual(embeddingFor({ base: "swf2es://app/" }, local, warn), {});
  assert.deepEqual(embeddingFor({ base: "javascript:alert(1)" }, remote, warn), {});
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /^--param base=file:\/\/\/etc\/: not an http, https or relative URL/);
});
