import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseColor,
  parseFlashVars,
  relativeBase,
  relativeUrls,
  scriptAccess,
} from "../../../packages/web/dist/attributes.js";

test("bgcolor is #RRGGBB or RRGGBB, nothing else", () => {
  assert.equal(parseColor("#FF8000"), 0xff8000);
  assert.equal(parseColor(" 00ff00 "), 0x00ff00);
  assert.equal(parseColor("red"), null);
  assert.equal(parseColor("#fff"), null);
  assert.equal(parseColor(null), null);
});

test("FlashVars are URL-encoded pairs, the last of a name winning", () => {
  assert.deepEqual(parseFlashVars("a=1&b=two%20words&c=x+y&a=3&empty="), {
    a: "3",
    b: "two words",
    c: "x y",
    empty: "",
  });
  assert.deepEqual(parseFlashVars(null), {});
});

test("allowScriptAccess: always, never, and by default the page's own origin", () => {
  const page = "https://site.test/game/index.html";
  assert.equal(scriptAccess("always", "https://cdn.test/a.swf", page), true);
  assert.equal(scriptAccess("NEVER", "a.swf", page), false);
  assert.equal(scriptAccess(null, "movies/a.swf", page), true);
  assert.equal(scriptAccess("sameDomain", "https://site.test/x/a.swf", page), true);
  assert.equal(scriptAccess("samedomain", "https://cdn.test/a.swf", page), false);
  assert.equal(scriptAccess(null, "http://site.test/a.swf", page), false);
  // Opaque origins are "null" both, and are no one's domain.
  assert.equal(scriptAccess(null, "blob:null/1", "blob:null/2"), false);
});

test("relativeurls is page or movie, the page's choice otherwise, else page", () => {
  assert.equal(relativeUrls("Movie", undefined), "movie");
  assert.equal(relativeUrls(" page ", "movie"), "page");
  assert.equal(relativeUrls(null, "movie"), "movie");
  assert.equal(relativeUrls("swf", undefined), "page");
});

test("base is the SWF's directory for \".\", against the page otherwise, else the page or each SWF's own", () => {
  const page = "https://site.test/play/index.html";
  const swf = "https://cdn.test/games/a.swf";
  // As Flash's plug-in loaded relative URLs for AS3 and AVM1 alike (PepperFlash 32).
  assert.equal(relativeBase(".", swf, page, "page"), "https://cdn.test/games/");
  assert.equal(relativeBase("assets/", swf, page, "page"), "https://site.test/play/assets/");
  assert.equal(relativeBase("https://x.test/y/", swf, page, "movie"), "https://x.test/y/");
  assert.equal(relativeBase(null, swf, page, "page"), page);
  assert.equal(relativeBase("", swf, page, "movie"), null);
  // A SWF given as bytes, or from blob: or data:, has no directory: "." is the page's.
  assert.equal(relativeBase(".", null, page, "page"), "https://site.test/play/");
  assert.equal(
    relativeBase(".", "blob:https://site.test/1234", page, "page"),
    "https://site.test/play/",
  );
  // A page with no path takes no relative base and gives none: each SWF its own.
  assert.equal(relativeBase("assets/", swf, "blob:https://site.test/5678", "page"), null);
  assert.equal(relativeBase(null, swf, "data:text/html,<embed>", "page"), null);
  assert.equal(relativeBase(".", swf, "about:blank", "page"), "https://cdn.test/games/");
  // Its query and fragment are kept here; a load's resolution leaves them out.
  assert.equal(
    relativeBase(null, swf, "https://site.test/play.php?file=/g/a.swf#x", "page"),
    "https://site.test/play.php?file=/g/a.swf#x",
  );
});
