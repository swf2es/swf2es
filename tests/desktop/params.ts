// The desktop app's embedding, end to end: a SWF given --flashvars and
// --param on the command line has them as a page's <object> or <embed>
// gave them, its loaderInfo.parameters or an AVM1 root's variables, its
// stage's quality, scale mode and alignment, and base resolving its
// relative URLs, an AVM1 SWF's against its own URL without one; a SWF
// URL's query is among its parameters, the FlashVars over it, as in Flash. A second start hands the first its own, a reload
// keeps them, and a SWF dropped on the window or opened without has none
// of the last's; no parameter but the element's reaches it.
// Skipped, saying why, where Electron was not downloaded
// (pnpm --filter @swf2es/desktop fetch-electron).
//
//   node tests/desktop/params.ts
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { missing } from "../../apps/desktop/src/launch/electron.ts";
import { as1, bare } from "../player/cases/common.ts";
import { libraryAbcs } from "../player/libraries.ts";
import { compileScripts } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";
import { display, withApp } from "./app.ts";

const why = missing();
if (why) {
  console.log(`desktop params test: skipped. ${why}`);
  process.exit(0);
}

const desktopPackage = fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url));
const out = fileURLToPath(new URL("out/params/", import.meta.url));
const libraries = fileURLToPath(new URL("out/libraries/", import.meta.url));
mkdirSync(`${out}site/sub`, { recursive: true });
libraryAbcs(libraries);
const scripts = compileScripts(
  [{ name: "Params", source: readFileSync(new URL("./Params.as", import.meta.url), "utf8") }],
  out,
);
const as3 = bare(scripts.get("Params") as Uint8Array, 1, "Params", 120, 100);
const local = `${out}site/params.swf`;
writeFileSync(local, as3);
writeFileSync(`${out}site/data.txt`, "beside");
writeFileSync(`${out}site/sub/data.txt`, "below");
// An AVM1 SWF's root has its parameters as variables before its first frame's actions run.
const avm1 = w.swf({
  version: 8,
  width: 120,
  height: 100,
  frameRate: 24,
  frameCount: 1,
  tags: [
    w.fileAttributes(false),
    w.backgroundColor(0xffffff),
    as1(
      'trace("avm1: a " + a + " q " + q + " b " + _root.b + " quality " + _quality); createEmptyMovieClip("child", 1).loadMovie("avm1-child.swf");',
      8,
    ),
    w.showFrame(),
    w.end(),
  ],
});
// What it loads by a relative URL comes from beside it, as Flash's projector had it, not from
// the app's page.
const avm1Child = w.swf({
  version: 8,
  width: 10,
  height: 10,
  frameCount: 1,
  tags: [w.fileAttributes(false), as1('trace("avm1 child: " + _url);', 8), w.showFrame(), w.end()],
});

const files: Record<string, [string, string | Uint8Array]> = {
  "/params.swf": ["application/x-shockwave-flash", as3],
  "/avm1.swf": ["application/x-shockwave-flash", avm1],
  "/avm1-child.swf": ["application/x-shockwave-flash", avm1Child],
  "/data.txt": ["text/plain", "remote"],
  "/sub/data.txt": ["text/plain", "remote below"],
};
const http = createServer((request, response) => {
  const file = files[new URL(request.url ?? "/", "http://x").pathname];
  if (file) {
    response.writeHead(200, { "content-type": file[0] }).end(file[1]);
  } else {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

const settings = {
  ...(process.env.SWF2ES_PLAYERGLOBAL === "adobe"
    ? { playerglobal: `${libraries}playerglobal-adobe.abc` }
    : {}),
  recent: [],
};

const screen = await display();
try {
  const args = [
    "--flashvars",
    "a=1&b=two%20words",
    "--param=flashvars=c=3",
    "--param",
    "quality=low",
    "--param",
    "Scale=noScale",
    "--param",
    "salign=TL",
    "--param",
    "base=sub/",
    "--param",
    "allowScriptAccess=always",
    "--param=workers=false",
    local,
    "--inspect=0",
  ];
  await withApp(screen.env, settings, args, async (app) => {
    const { stdout, stderr, until, evaluate, again, main, devtools } = app;
    const cleared = `["flashvars", "quality", "scale", "salign", "base", "workers"].every((n) => !document.getElementById("player").hasAttribute(n))`;
    const count = (line: string) => stdout.filter((l) => l === line).length;
    const params = (n: number) => () =>
      stdout.filter((l) => l.startsWith("params: data ")).length >= n;
    await until("the local SWF", params(1));
    assert.equal(count("params: a=1 b=two words c=3"), 1);
    assert.equal(count("params: quality LOW scaleMode noScale align TL"), 1);
    assert.equal(count("params: data below"), 1);
    assert.match(stderr(), /--param allowscriptaccess: ignored, ExternalInterface stays off/);
    assert.equal(
      await evaluate<string | null>(
        `document.getElementById("player").getAttribute("allowscriptaccess")`,
      ),
      "never",
    );
    assert.match(stderr(), /--param workers: no such parameter/);
    assert.equal(
      await evaluate<boolean>(`document.getElementById("player").hasAttribute("workers")`),
      false,
    );

    // Dropped on the window, the same SWF has none of them.
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await devtools.send("Input.dispatchDragEvent", {
        type,
        x: 60,
        y: 50,
        data: { items: [], files: [local], dragOperationsMask: 1 },
      });
    }

    await until("the dropped SWF", params(2));
    assert.equal(count("params: "), 1);
    assert.equal(count("params: quality HIGH scaleMode showAll align "), 1);
    assert.equal(count("params: data beside"), 1);
    assert.equal(await evaluate<boolean>(cleared), true);

    // A second start's own, the URL's query among them under its FlashVars.
    const avm1Url = `${origin}/avm1.swf?q=query&a=query`;
    assert.equal(
      await again(["--flashvars=a=flash&b=root", "--param", "quality=medium", avm1Url]),
      0,
    );
    const avm1Line = "avm1: a flash q query b root quality MEDIUM";
    await until("the AVM1 SWF", () => count(avm1Line) === 1);
    await until("the AVM1 SWF's child", () => count(`avm1 child: ${origin}/avm1-child.swf`) === 1);

    // Played again by View › Reload Movie: with them again.
    await main(`(() => {
      const electron = process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})("electron");
      const item = electron.Menu.getApplicationMenu().getMenuItemById("reload-movie");
      item.click(item, electron.BrowserWindow.getAllWindows()[0]);
      return true;
    })()`);
    await until("the AVM1 SWF played again", () => count(avm1Line) === 2);

    // Opened by its URL alone: its query, and none of the last SWF's.
    assert.equal(await again([`${origin}/params.swf?from=query`]), 0);
    await until("the remote SWF", params(3));
    assert.equal(count("params: from=query"), 1);
    assert.equal(count("params: quality HIGH scaleMode showAll align "), 2);
    assert.equal(count("params: data remote"), 1);
    assert.equal(await evaluate<boolean>(cleared), true);

    // The page reloaded, as a change of the Stage3D choice reloads it, plays what played as it was.
    await main(`(() => {
      const electron = process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})("electron");
      electron.BrowserWindow.getAllWindows()[0].webContents.reload();
      return true;
    })()`);
    await until("the remote SWF reloaded", params(4));
    assert.equal(count("params: from=query"), 2);
  });
  console.log("desktop params test: ok");
} finally {
  http.close();
  screen.stop();
}
