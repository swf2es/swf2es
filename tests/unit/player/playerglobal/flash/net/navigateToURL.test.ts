import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { browserNavigate } from "../../../../../../packages/player/dist/playerglobal/flash/net/navigateToURL.js";
import { type FetchRequest, Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compileScripts } from "../../../../../player/scripts.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../../../out/player-navigate/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

// The errors are what adl traces for the same calls.
const source = `package {
  import flash.display.Sprite;
  import flash.net.*;
  public class Main extends Sprite {
    public function Main() {
      function t(name:String, f:Function):void {
        try { f(); trace(name, "ok"); } catch (e:Error) { trace(name, Object(e).constructor, e.message); }
      }
      t("nav null", function():void { navigateToURL(null); });
      t("nav null url", function():void { navigateToURL(new URLRequest(), "_self"); });
      t("send null", function():void { sendToURL(null); });
      t("send null url", function():void { sendToURL(new URLRequest()); });

      var vars:URLVariables = new URLVariables();
      vars.q = "a b";
      var get:URLRequest = new URLRequest("page.html?x=1");
      get.data = vars;
      t("nav get", function():void { navigateToURL(get, "_self"); });
      t("nav default", function():void { navigateToURL(new URLRequest("/top.html")); });
      var post:URLRequest = new URLRequest("http://other.test/form");
      post.method = URLRequestMethod.POST;
      post.data = vars;
      t("nav post", function():void { navigateToURL(post, "named"); });
      t("send", function():void { sendToURL(new URLRequest("ping")); });
      t("nav blank", function():void { navigateToURL(new URLRequest("b"), "Blank"); });
      t("nav blanket", function():void { navigateToURL(new URLRequest("c"), "_blanket"); });
      t("nav empty", function():void { navigateToURL(new URLRequest("")); });
      var put:URLRequest = new URLRequest("put.html");
      put.method = "PUT";
      put.data = vars;
      t("nav put", function():void { navigateToURL(put); });
    }
  }
}`;

test("navigateToURL hands the host the resolved request and window, sendToURL the host's fetch", {
  skip,
}, async () => {
  const [abc] = compileScripts([{ name: "Main", source }], out).values();
  const lines: string[] = [];
  const opened: { url: string; method: string; body: string | null; window: string | null }[] = [];
  const sent: FetchRequest[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // Whose messages adl traces.
    debugger: true,
    url: "http://example.test/games/main.swf",
    navigate: (request, window) =>
      opened.push({
        url: request.url,
        method: request.method,
        body: request.body && new TextDecoder().decode(request.body),
        window,
      }),
    fetch: async (request) => {
      sent.push(request);
      return { bytes: new Uint8Array(), status: 200, headers: [] };
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(bare(abc, 1), scripting).start();

  assert.deepEqual(lines, [
    "nav null [class TypeError] Error #2007: Parameter request must be non-null.",
    "nav null url [class TypeError] Error #2007: Parameter url must be non-null.",
    "send null [class TypeError] Error #2007: Parameter request must be non-null.",
    "send null url [class TypeError] Error #2007: Parameter url must be non-null.",
    "nav get ok",
    "nav default ok",
    "nav post ok",
    "send ok",
    "nav blank ok",
    "nav blanket ok",
    "nav empty ok",
    "nav put ok",
  ]);
  assert.deepEqual(opened, [
    {
      url: "http://example.test/games/page.html?x=1&q=a%20b",
      method: "GET",
      body: null,
      window: "_self",
    },
    { url: "http://example.test/top.html", method: "GET", body: null, window: null },
    { url: "http://other.test/form", method: "POST", body: "q=a%20b", window: "named" },
    { url: "http://example.test/games/b", method: "GET", body: null, window: "_blank" },
    { url: "http://example.test/games/c", method: "GET", body: null, window: "_blanket" },
    // A browser navigates by GET or POST only: Flash sends any other method as a GET.
    { url: "http://example.test/games/put.html?q=a%20b", method: "GET", body: null, window: null },
  ]);
  assert.deepEqual(
    sent.map(({ url, method }) => [url, method]),
    [["http://example.test/games/ping", "GET"]],
  );
});

test("where there is no window to open, as in node, the player opens no pages", async () => {
  const scripting = new Scripting(await createCodegen(wasm));
  assert.equal(scripting.navigate, null);
});

/** A window and document that record what the browser's default would open and submit. */
function stubBrowser(t: { after: (fn: () => void) => void }) {
  const opened: [string, string][] = [];
  const submitted: {
    method: string;
    rel: string;
    action: string;
    target: string;
    fields: [string, string][];
  }[] = [];
  const saved = ["open", "document", "location"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });

  interface Form {
    method: string;
    rel: string;
    action: string;
    target: string;
    children: { name: string; value: string }[];
  }
  const body = {
    append(form: Form) {
      submitted.push({
        method: form.method,
        rel: form.rel,
        action: form.action,
        target: form.target,
        fields: form.children.map(({ name, value }) => [name, value]),
      });
    },
  };
  const document = {
    body: body as typeof body | null,
    createElement: () => {
      const children: unknown[] = [];
      return {
        style: {},
        children,
        append: (child: unknown) => children.push(child),
        submit: () => {},
        remove: () => {},
      };
    },
  };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("open", (url: string, target: string) => opened.push([url, target]));
  define("document", document);
  define("location", { href: "https://page.test/player/index.html" });
  return { opened, submitted, document };
}

const request = (url: string, method = "GET", body: string | null = null): FetchRequest => ({
  url,
  method,
  headers: [],
  body: body === null ? null : new TextEncoder().encode(body),
});

test("the browser's default opens only http and https, and never in the page's own frames", (t) => {
  const { opened, submitted } = stubBrowser(t);
  const navigate = browserNavigate();
  assert.ok(navigate);

  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " \tjavascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://page.test/x",
    "file:///etc/passwd",
  ]) {
    navigate(request(url), "_blank");
    navigate(request(url, "POST", "a=1"), "_blank");
  }

  for (const target of ["_self", "_SELF", "_parent", "_top", ""]) {
    navigate(request("https://other.test/"), target);
  }

  navigate(request("https://other.test/form", "POST", "a=1"), "_top");
  assert.deepEqual(opened, []);
  assert.deepEqual(submitted, []);

  navigate(request("https://other.test/a"), null);
  navigate(request("c.html"), "_BLANK");
  assert.deepEqual(opened, [
    ["https://other.test/a", "_blank"],
    ["https://page.test/player/c.html", "_blank"],
  ]);
});

// A name would reach the window or frame of that name, the page's own among them, noopener or not.
test("the browser's default opens a named target as a new window", (t) => {
  const { opened, submitted } = stubBrowser(t);
  const navigate = browserNavigate();
  assert.ok(navigate);

  navigate(request("https://other.test/a"), "main");
  navigate(request("https://other.test/form", "POST", "a=1"), "f");
  assert.deepEqual(opened, [["https://other.test/a", "_blank"]]);
  assert.deepEqual(
    submitted.map(({ action, target }) => [action, target]),
    [["https://other.test/form", "_blank"]],
  );
});

test("the browser's default posts any body as form data, and nothing before the page has a body", (t) => {
  const { submitted, document } = stubBrowser(t);
  const navigate = browserNavigate();
  assert.ok(navigate);

  navigate(request("https://other.test/form", "POST", "a=1&b=x%20y"), "_blank");
  navigate(request("https://other.test/json", "POST", '{"a":1}'), null);
  assert.deepEqual(submitted, [
    {
      method: "POST",
      rel: "noopener",
      action: "https://other.test/form",
      target: "_blank",
      fields: [
        ["a", "1"],
        ["b", "x y"],
      ],
    },
    {
      method: "POST",
      rel: "noopener",
      action: "https://other.test/json",
      target: "_blank",
      fields: [['{"a":1}', ""]],
    },
  ]);

  document.body = null;
  assert.doesNotThrow(() => navigate(request("https://other.test/form", "POST", "a=1"), "_blank"));
  assert.equal(submitted.length, 2);
});
