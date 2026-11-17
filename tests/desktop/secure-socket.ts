// AS3 through Electron's preload, permission dialog and TLS transport.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { missing } from "../../apps/desktop/src/launch/electron.ts";
import { compiler } from "../player/scripts.ts";
import * as w from "../swf-writer.ts";
import { tlsCertificates } from "../tls-certificates.ts";
import { display, withApp } from "./app.ts";
import { testProxy } from "./proxy-server.ts";

const why = missing();
if (why) {
  console.log(`desktop SecureSocket: skipped. ${why}`);
  process.exit(0);
}

const out = fileURLToPath(new URL("out/secure-socket/", import.meta.url));
mkdirSync(out, { recursive: true });
const compile = compiler(out);
const source = readFileSync(new URL("../player/scripts/SecureSockets.as", import.meta.url), "utf8");
const desktopPackage = fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url));
const electron = `process.getBuiltinModule("module").createRequire(${JSON.stringify(desktopPackage)})("electron")`;
const certificates = tlsCertificates();
const screen = await display();

try {
  for (const scenario of [
    "allow",
    "deny",
    "self-allow",
    "self-deny",
    "self-flash",
    "cancel",
    "socks5",
    "http",
  ] as const) {
    const self = scenario.startsWith("self-");
    const air = self && scenario !== "self-flash";
    const peers = new Set<TLSSocket>();
    let connections = 0;
    const server = createServer(
      {
        key: self ? certificates.selfKey : certificates.key,
        cert: self ? certificates.self : certificates.leaf,
      },
      (peer) => {
        peers.add(peer);
        peer.on("error", () => {});
        peer.on("close", () => peers.delete(peer));
        peer.on("data", (bytes) => peer.write(bytes));
      },
    );
    server.on("connection", () => connections++);
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const proxy = scenario === "socks5" || scenario === "http" ? await testProxy(scenario) : null;
    try {
      const config = {
        port: String(port),
        wait: "true",
        air: String(air),
        ...(self
          ? { accept: scenario === "self-deny" ? "no" : "yes" }
          : { ca: certificates.ca.toString("hex") }),
      };
      const abc = compile(
        "SecureSockets",
        source.replace("loaderInfo.parameters", JSON.stringify(config)),
      );
      const movie = `${out}network.swf`;
      writeFileSync(
        movie,
        w.swf({
          width: 200,
          height: 100,
          frameRate: 24,
          frameCount: 1,
          tags: [
            w.fileAttributes(true, true),
            w.doAbc(abc, "SecureSockets"),
            w.symbolClass([[0, "SecureSockets"]]),
            w.showFrame(),
            w.end(),
          ],
        }),
      );
      const descriptor = `${out}app.xml`;
      writeFileSync(
        descriptor,
        `<application xmlns="http://ns.adobe.com/air/application/51.3"><id>org.swf2es.securesocket.test</id><versionNumber>1.0</versionNumber><filename>SecureSocket test</filename><initialWindow><content>network.swf</content><visible>true</visible></initialWindow></application>`,
      );
      await withApp(
        screen.env,
        { sockets: {} },
        [
          "--trace",
          "--inspect=0",
          ...(proxy ? [`--proxy=${proxy.url()}`] : []),
          air ? descriptor : movie,
        ],
        async (app) => {
          await app.until("the SecureSocket SWF ready", () => app.stdout.includes("ready"));
          assert.equal(connections, 0, "certificate parsing must not open the network connection");
          const response = scenario === "deny" ? 2 : 0;
          await app.main(`(() => {
          globalThis.socketQuestions = [];
          ${electron}.dialog.showMessageBox = (_window, options) => {
            globalThis.socketQuestions.push({ message: options.message, buttons: options.buttons });
            return new Promise((resolve) => {
              globalThis.answerSocket = () => resolve({ response: ${response}, checkboxChecked: false });
              if (${scenario !== "cancel"}) globalThis.answerSocket();
            });
          };
          return true;
        })()`);
          const point = await app.evaluate<{ x: number; y: number }>(
            `(() => { const r = document.getElementById("player").shadowRoot.querySelector("canvas").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
          );
          await app.devtools.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            ...point,
            button: "left",
            clickCount: 1,
          });
          await app.devtools.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...point,
            button: "left",
            clickCount: 1,
          });
          if (scenario === "cancel") {
            for (
              let i = 0;
              i < 100 && !(await app.main<boolean>("Boolean(globalThis.answerSocket)"));
              i++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(await app.main<boolean>("Boolean(globalThis.answerSocket)"), true);
            await app.evaluate("window.swf2esDesktop.sockets.close(1)");
            await app.until("the cancelled socket", () => app.stdout.includes("done"));
            await app.main("globalThis.answerSocket(); true");
            await new Promise((resolve) => setTimeout(resolve, 100));
          } else {
            await app.until("the SecureSocket outcome", () => app.stdout.includes("done"));
          }
          const questions = await app.main<{ message: string; buttons: string[] }[]>(
            "globalThis.socketQuestions",
          );
          assert.equal(questions.length, air ? 0 : 1);
          if (!air) {
            assert.ok(questions[0].message.includes(`localhost:${port}`));
            assert.deepEqual(questions[0].buttons, [
              "Allow Once",
              "Always Allow for This SWF",
              "Deny",
            ]);
          }
          if (scenario === "deny" || scenario === "cancel") {
            assert.equal(connections, 0);
            assert.ok(app.stdout.includes("error 2031 unknown false"), app.stdout.join("\n"));
          } else if (scenario === "self-deny" || scenario === "self-flash") {
            assert.equal(
              app.stdout.includes("certificateError true unknown"),
              air,
              app.stdout.join("\n"),
            );
            assert.ok(
              app.stdout.includes("error 2031 untrustedSigners true"),
              app.stdout.join("\n"),
            );
          } else {
            assert.ok(app.stdout.includes("data 16909060 255"), app.stdout.join("\n"));
            assert.ok(app.stdout.includes("closed false trusted null"), app.stdout.join("\n"));
            if (proxy) {
              assert.deepEqual(proxy.targets, [`localhost:${port}`]);
            }
          }
        },
      );
      console.log(`desktop SecureSocket: ${scenario} passed`);
    } finally {
      for (const peer of peers) {
        peer.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await proxy?.close();
    }
  }
} finally {
  screen.stop();
  certificates.dispose();
}
