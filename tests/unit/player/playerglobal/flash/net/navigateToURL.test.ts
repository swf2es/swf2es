import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { FetchRequest } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
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
