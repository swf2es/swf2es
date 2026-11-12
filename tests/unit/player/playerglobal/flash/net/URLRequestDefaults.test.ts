// flash.net.URLRequestDefaults as adl (AIR 51.3) has them: AIR's defaults
// and user agent, values a request copies as it is made and keeps, an idle
// timeout below zero refused, there and on a request, and a null or empty
// agent read as AIR's own (tests/player's url-request-defaults-natives
// holds the player to adl's trace of the same). On the web, which keeps the
// class Flash Player lacks, the agent is the browser's.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import {
  builtinLibrary,
  playerglobalLibrary,
  playerHooks,
  playerNatives,
} from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

const NAMES = ["authenticate", "cacheResponse", "followRedirects", "manageCookies", "useCache"];
const AIR_WINDOWS =
  "Mozilla/5.0 (Windows; U; en-US) AppleWebKit/533.19.4 (KHTML, like Gecko) AdobeAIR/51.3";

async function air(manufacturer = "Adobe Windows", inAir = true) {
  const s = new Scripting(await createCodegen(wasm), {
    air: inAir,
    platform: { manufacturer, locale: "en-US" },
  });
  await s.loadLibraries([builtinLibrary, playerglobalLibrary]);
  const natives = playerNatives(s);
  const create = playerHooks(s)["flash.net::URLRequest"].create;
  assert.ok(create);
  const call = (key: string, self: unknown, ...args: unknown[]) =>
    (natives[key](s.rt) as (...a: unknown[]) => unknown).call(self, ...args);
  return {
    s,
    defaults: (name: string) => call(`flash.net::URLRequestDefaults.get:${name}`, null),
    setDefault: (name: string, v: unknown) =>
      call(`flash.net::URLRequestDefaults.set:${name}`, null, v),
    request: () => create({ proto: {} } as never, s.rt),
    get: (r: unknown, name: string) => call(`flash.net::URLRequest#get:${name}`, r),
    set: (r: unknown, name: string, v: unknown) =>
      name === "idleTimeout"
        ? call("flash.net::URLRequest#flash.net:URLRequest::_SetIdleTimeout", r, v)
        : call(`flash.net::URLRequest#set:${name}`, r, v),
    call,
  };
}

const errorOf = (s: Scripting, f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return s.rt.toString(e as never);
  }

  return "no error";
};

test("URLRequestDefaults start as AIR's, with AIR's user agent for the platform", async () => {
  const a = await air();
  assert.deepEqual(
    NAMES.map((n) => a.defaults(n)),
    [true, true, true, true, true],
  );
  assert.equal(a.defaults("idleTimeout"), 0);
  assert.equal(a.defaults("userAgent"), AIR_WINDOWS);
  assert.equal(
    (await air("Adobe Macintosh")).defaults("userAgent"),
    "Mozilla/5.0 (Macintosh; U; Intel Mac OS X; en-US) AppleWebKit/533.19.4 (KHTML, like Gecko) AdobeAIR/51.3",
  );
  assert.equal(
    (await air("Adobe Linux")).defaults("userAgent"),
    "Mozilla/5.0 (X11; U; Linux x86_64; en-US) AppleWebKit/533.19.4 (KHTML, like Gecko) AdobeAIR/51.3",
  );
  assert.equal(
    (await air("Adobe Windows", false)).defaults("userAgent"),
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? AIR_WINDOWS,
  );
  assert.equal(a.call("flash.net::URLRequestDefaults.setLoginCredentialsForHost", null), undefined);
});

test("a request copies the defaults as it is made, and keeps them", async () => {
  const a = await air();
  const before = a.request();
  for (const n of NAMES) {
    a.setDefault(n, false);
  }

  a.setDefault("idleTimeout", 2.5);
  a.setDefault("userAgent", "x");
  const after = a.request();
  assert.deepEqual(
    NAMES.map((n) => [a.get(before, n), a.get(after, n)]),
    NAMES.map(() => [true, false]),
  );
  assert.deepEqual([a.get(before, "idleTimeout"), a.get(after, "idleTimeout")], [0, 2.5]);
  assert.deepEqual([a.get(before, "userAgent"), a.get(after, "userAgent")], [AIR_WINDOWS, "x"]);

  // A request's null is AIR's own agent, not the defaults'; its "" stays.
  a.set(after, "userAgent", null);
  assert.equal(a.get(after, "userAgent"), AIR_WINDOWS);
  a.setDefault("userAgent", "");
  assert.equal(a.defaults("userAgent"), AIR_WINDOWS);
  assert.equal(a.get(a.request(), "userAgent"), "");
  a.setDefault("userAgent", null);
  assert.equal(a.defaults("userAgent"), AIR_WINDOWS);
  assert.equal(a.get(a.request(), "userAgent"), AIR_WINDOWS);
});

test("an idle timeout below zero is refused, NaN kept", async () => {
  const a = await air();
  // A release player's text: the debugger's adds the message.
  const refused = "RangeError: Error #2006";
  assert.equal(
    errorOf(a.s, () => a.setDefault("idleTimeout", -1)),
    refused,
  );
  assert.equal(
    errorOf(a.s, () => a.set(a.request(), "idleTimeout", -0.5)),
    refused,
  );
  assert.equal(a.defaults("idleTimeout"), 0);
  a.setDefault("idleTimeout", Number.NaN);
  assert.ok(Number.isNaN(a.defaults("idleTimeout")));
  assert.ok(Number.isNaN(a.get(a.request(), "idleTimeout")));
});
