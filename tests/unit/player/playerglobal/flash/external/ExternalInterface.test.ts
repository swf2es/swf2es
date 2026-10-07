import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { ExternalInterfaceHost } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { externalInterfaceNatives } from "../../../../../../packages/player/dist/playerglobal/flash/external/ExternalInterface.js";
import type { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { Scripting as PlayerScripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

const CLASS = "flash.external::ExternalInterface";
const PRIVATE = `${CLASS}.flash.external:ExternalInterface::`;

function scripting(host: ExternalInterfaceHost | null): Scripting {
  const rt = {
    toString: String,
    array: (values: unknown[]) => ({ $a: values }),
    callValue: (
      closure: { $f: (...args: unknown[]) => unknown },
      _receiver: unknown,
      args: unknown[],
    ) => closure.$f(...args),
    error: (_name: string, id: number) => new Error(`Error #${id}`),
    hasNext: (_object: unknown, index: number) => (index < 2 ? index + 1 : 0),
    nextName: (_object: unknown, index: number) => ["first", "second"][index - 1],
  };
  return { rt, externalInterface: host, hostCalls: 0 } as unknown as Scripting;
}

test("ExternalInterface reports an unavailable host and keeps callbacks per player", () => {
  const unavailable = scripting(null);
  const absent = externalInterfaceNatives(unavailable);
  assert.equal(absent[`${CLASS}.get:available`](unavailable.rt).call(null), false);
  assert.equal(absent[`${CLASS}.get:objectID`](unavailable.rt).call(null), null);
  assert.throws(
    () => absent[`${PRIVATE}_evalJS`](unavailable.rt).call(null, "source"),
    /Error #2067/,
  );

  const calls: string[] = [];
  const callbacks: { current: ((request: string, args: unknown[] | null) => unknown) | null } = {
    current: null,
  };
  const first = scripting({
    objectID: "first",
    evalJS(source) {
      calls.push(`eval ${source}`);
      return null;
    },
    callOut(request) {
      calls.push(`call ${request}`);
      return "<null/>";
    },
    addCallback(name, value) {
      calls.push(`callback ${name}`);
      callbacks.current = value;
    },
  });
  const second = scripting({
    objectID: "second",
    evalJS: () => "<undefined/>",
    callOut: () => null,
    addCallback: () => {},
  });
  const a = externalInterfaceNatives(first);
  const b = externalInterfaceNatives(second);

  assert.equal(a[`${CLASS}.get:available`](first.rt).call(null), true);
  assert.equal(a[`${CLASS}.get:objectID`](first.rt).call(null), "first");
  assert.equal(b[`${CLASS}.get:objectID`](second.rt).call(null), "second");
  assert.equal(
    a[`${CLASS}.get:flash.external:ExternalInterface::activeX`](first.rt).call(null),
    false,
  );
  assert.equal(a[`${PRIVATE}_initJS`](first.rt).call(null), undefined);
  assert.deepEqual(a[`${PRIVATE}_getPropNames`](first.rt).call(null, {}), {
    $a: ["first", "second"],
  });
  assert.equal(a[`${PRIVATE}_evalJS`](first.rt).call(null, "source"), null);
  assert.equal(a[`${PRIVATE}_callOut`](first.rt).call(null, "<invoke/>"), "<null/>");
  assert.deepEqual(calls, ["eval source", "call <invoke/>"]);

  const closure = {
    $f: (request: string, args: { $a: unknown[] } | null) => `${request}:${args?.$a ?? "none"}`,
  };
  a[`${PRIVATE}_addCallback`](first.rt).call(null, "ready", closure, false);
  assert.equal(callbacks.current?.("message", [1, 2]), "message:1,2");
  // A call from the page runs outside a frame: a change a host draws for.
  assert.equal(first.hostCalls, 1);
  // An XML invocation alone: playerglobal's _callIn reads its arguments from it.
  assert.equal(callbacks.current?.("<invoke/>", null), "<invoke/>:none");
  a[`${PRIVATE}_addCallback`](first.rt).call(null, "ready", closure, true);
  assert.equal(callbacks.current, null);
  assert.deepEqual(calls.slice(2), ["callback ready", "callback ready"]);
  assert.equal(first.hostCalls, 2);
});

test("ExternalInterface quotes JavaScript string and error arguments", () => {
  const s = scripting(null);
  const natives = externalInterfaceNatives(s);
  const quote = natives[`${PRIVATE}_quotedStringFromString`](s.rt);
  const quoteError = natives[`${PRIVATE}_quotedStringFromError`](s.rt);
  const value = 'quote " slash \\ newline \n tab \t null \0';

  assert.equal(JSON.parse(quote.call(null, value) as string), value);
  assert.equal(quote.call(null, value), JSON.stringify(value));
  assert.equal(
    JSON.parse(quoteError.call(null, new Error("bad input")) as string),
    "Error: bad input",
  );
});

test("ExternalInterface asks the host whether the calling SWF may use it", () => {
  const callers: string[] = [];
  let caller = "http://page.test/main.swf";
  const s = scripting({
    objectID: "movie",
    evalJS: () => "<null/>",
    callOut: () => null,
    addCallback: () => {},
    allows: (url) => {
      callers.push(url);
      return url.startsWith("http://page.test/");
    },
  });
  (s as unknown as { code: { codeUrl(): string } }).code = { codeUrl: () => caller };
  const natives = externalInterfaceNatives(s);
  assert.equal(natives[`${CLASS}.get:available`](s.rt).call(null), true);
  assert.equal(natives[`${PRIVATE}_evalJS`](s.rt).call(null, "source"), "<null/>");

  // A child from another origin, which the main SWF loaded: as if there were no bridge.
  caller = "http://other.test/child.swf";
  assert.equal(natives[`${CLASS}.get:available`](s.rt).call(null), false);
  assert.equal(natives[`${CLASS}.get:objectID`](s.rt).call(null), null);
  assert.throws(() => natives[`${PRIVATE}_evalJS`](s.rt).call(null, "source"), /Error #2067/);
  assert.throws(
    () => natives[`${PRIVATE}_addCallback`](s.rt).call(null, "x", { $f: () => 1 }, false),
    /Error #2067/,
  );
  assert.deepEqual(
    new Set(callers),
    new Set(["http://page.test/main.swf", "http://other.test/child.swf"]),
  );
});

const out = fileURLToPath(new URL("../../../../out/player-external/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

test("a loaded SWF's calls are checked against its own URL, not the main SWF's", {
  skip,
}, async () => {
  const compile = compiler(out);
  const child = (name: string) =>
    bare(
      compile(
        name,
        `package {
  import flash.display.Sprite;
  import flash.external.ExternalInterface;
  public class ${name} extends Sprite {
    public function ${name}() {
      trace("${name}", ExternalInterface.available);
      try {
        ExternalInterface.call("hello", "${name}");
      } catch (e:Error) {
        trace("${name}", e.errorID);
      }
    }
  }
}`,
      ),
      1,
      name,
    );
  const children: Record<string, Uint8Array> = {
    "http://page.test/same.swf": child("EiSameChild"),
    "http://other.test/child.swf": child("EiOtherChild"),
  };
  const main = bare(
    compile(
      "EiLoader",
      `package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.net.URLRequest;
  public class EiLoader extends Sprite {
    public function EiLoader() {
      for each (var url:String in ["http://page.test/same.swf", "http://other.test/child.swf"]) {
        var loader:Loader = new Loader();
        loader.load(new URLRequest(url));
        addChild(loader);
      }
    }
  }
}`,
    ),
    3,
    "EiLoader",
  );
  const lines: string[] = [];
  const evaluated: string[] = [];
  const scripting = new PlayerScripting(
    await createCodegen(
      await WebAssembly.compile(
        await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
      ),
    ),
    {
      print: (line) => lines.push(line),
      url: "http://page.test/main.swf",
      fetch: async ({ url }) => ({ bytes: children[url] ?? null, status: 200, headers: [] }),
      externalInterface: {
        evalJS: (source) => {
          evaluated.push(source);
          return "<undefined/>";
        },
        callOut: () => null,
        addCallback: () => {},
        allows: (url) => new URL(url).origin === "http://page.test",
      },
    },
  );
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(main, scripting);
  await player.start();
  for (let i = 0; i < 2; i++) {
    await scripting.settled();
    player.tick();
  }

  assert.deepEqual(lines.sort(), ["EiOtherChild 2067", "EiOtherChild false", "EiSameChild true"]);
  assert.equal(evaluated.length, 1);
  assert.match(evaluated[0], /hello\("EiSameChild"\)/);
});
