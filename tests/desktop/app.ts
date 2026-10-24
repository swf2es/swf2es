import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "../../apps/desktop/electron.ts";
import { DevTools } from "../player/chrome.ts";

const appDir = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const TIMEOUT = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A display of the test's own. Electron's --headless still draws through
 * a Wayland or X display it finds, and a compositor whose screen is
 * locked or asleep sends it no frames, so the player never advanced; and
 * with no display at all GTK aborts it ("Can't create a GtkStyleContext
 * without a display connection"), as on a CI runner. So the test starts
 * an Xvfb where there is one, and draws there; elsewhere it leaves the
 * user's display out, which GTK still finds through XDG_RUNTIME_DIR.
 */
export async function display(): Promise<{ env: NodeJS.ProcessEnv; stop(): void }> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "DISPLAY" && name !== "WAYLAND_DISPLAY",
    ),
  );
  const xvfb = spawnSync("sh", ["-c", "command -v Xvfb"], { encoding: "utf8" }).stdout.trim();
  if (!xvfb) {
    return { env: base, stop() {} };
  }

  // Xvfb writes the display it chose to the descriptor -displayfd names.
  const x = spawn(xvfb, ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const number = await new Promise<string>((done, fail) => {
    let text = "";
    x.stdio[3]?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) {
        done(text.trim());
      }
    });
    x.on("exit", (code) => fail(new Error(`Xvfb exited with ${code}`)));
  });
  return {
    env: { ...base, DISPLAY: `:${number}`, GDK_BACKEND: "x11", XDG_SESSION_TYPE: "x11" },
    stop: () => x.kill(),
  };
}

/** The app running in Electron with these settings and arguments, its terminal and its page. */
export interface App {
  /** What it printed to stdout, a line each: the SWF's traces. */
  stdout: string[];
  stderr(): string;
  /** Wait until `done`, failing with what the app printed if it exits or a minute passes. */
  until(what: string, done: () => boolean): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** The main process's inspector, available only when the test passes --inspect=0. */
  main<T>(expression: string): Promise<T>;
  devtools: DevTools;
  /** Start the app again on the same user data, with `args`; its exit code. */
  again(args: string[]): Promise<number | null>;
  /** DevTools for another of its pages, once there is one whose URL starts with `prefix`. */
  page(prefix: string): Promise<DevTools>;
  userData: string;
}

export async function withApp(
  env: NodeJS.ProcessEnv,
  settings: object,
  args: string[],
  run: (app: App) => Promise<void>,
): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), "swf2es-desktop-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify(settings));
  const stdout: string[] = [];
  let stderr = "";
  let exited: string | null = null;
  let electron: ChildProcess | null = null;
  let socket: WebSocket | null = null;
  /** The other pages' DevTools connections. */
  const sockets: WebSocket[] = [];
  const start = (more: string[]) =>
    spawn(
      electronBinary() as string,
      [
        appDir,
        // Chromium's headless mode, which Electron keeps (its build has no
        // headless Ozone), on the test's own display (display()), and a GPU
        // of software: it draws alike anywhere.
        "--headless",
        // Electron can still find Wayland through XDG_RUNTIME_DIR while Xvfb owns DISPLAY.
        ...(env.GDK_BACKEND === "x11" ? ["--ozone-platform=x11"] : []),
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        ...more,
      ],
      {
        env: { ...env, SWF2ES_DESKTOP_USER_DATA: userData },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  try {
    electron = start(["--trace", "--remote-debugging-port=0", ...args]);
    electron.on("exit", (code, signal) => {
      exited = `exit ${code ?? signal}`;
    });
    let partial = "";
    electron.stdout?.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).split("\n");
      partial = lines.pop() ?? "";
      stdout.push(...lines);
    });
    electron.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const until = async (what: string, done: () => boolean) => {
      for (let waited = 0; !done(); waited += 100) {
        if (exited || waited > TIMEOUT) {
          throw new Error(
            `${what}: ${exited ?? "timed out"}\nstdout:\n${stdout.join("\n")}\nstderr:\n${stderr}`,
          );
        }

        await sleep(100);
      }
    };

    // Electron writes the port it chose into its user data, as Chrome into its profile.
    let port = "";
    await until("the DevTools port", () => {
      try {
        port = readFileSync(join(userData, "DevToolsActivePort"), "utf8").split("\n")[0];
      } catch {
        // Not yet.
      }

      return port !== "";
    });
    // The window's page, as DevTools lists it: a cold start on a CI runner
    // has taken more than 10 s to open it.
    let target: { webSocketDebuggerUrl: string } | undefined;
    let targets: { type: string; url: string; webSocketDebuggerUrl: string }[] = [];
    for (let waited = 0; !target; waited += 250) {
      try {
        targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as typeof targets;
      } catch {
        // Not listening yet.
      }

      target = targets.find((t) => t.type === "page" && t.url.startsWith("swf2es://app/"));
      if (!target) {
        if (exited || waited > TIMEOUT) {
          throw new Error(
            `the app's page on swf2es://app/: ${exited ?? "timed out"}, ` +
              `DevTools listing ${JSON.stringify(targets)}\nstderr:\n${stderr}`,
          );
        }

        await sleep(250);
      }
    }

    const connected = new WebSocket(target.webSocketDebuggerUrl);
    socket = connected;
    await new Promise((done, fail) => {
      connected.addEventListener("open", done);
      connected.addEventListener("error", fail);
    });
    const devtools = new DevTools(connected);
    const evaluateOn = async <T>(client: DevTools, expression: string): Promise<T> => {
      const { result, exceptionDetails } = await client.send<{
        result: { value: T };
        exceptionDetails?: { exception?: { description?: string } };
      }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      assert.equal(exceptionDetails, undefined, exceptionDetails?.exception?.description);
      return result.value;
    };
    const evaluate = <T>(expression: string) => evaluateOn<T>(devtools, expression);
    /**
     * Wait until the page on `devtools` shows the document whose URL starts
     * with `prefix`. DevTools lists a new window by the URL it is navigating
     * to while it still shows its first about:blank, and the app's pages are
     * cross-origin isolated, so that navigation moves the window to another
     * renderer: an evaluation sent across the move finds no context, which
     * means only that the document is still on its way.
     */
    const shown = async (page: DevTools, prefix: string) => {
      for (let waited = 0; ; waited += 50) {
        const href = await page
          .send<{ result: { value?: string } }>("Runtime.evaluate", {
            expression: "location.href",
            returnByValue: true,
          })
          .then(
            ({ result }) => result.value ?? "",
            (error: Error) => {
              if (!/Cannot find default execution context/.test(error.message)) {
                throw error;
              }

              return "";
            },
          );
        if (href.startsWith(prefix)) {
          return;
        }

        if (exited || waited > TIMEOUT) {
          throw new Error(`the page on ${prefix}: ${exited ?? "timed out"} at ${href}`);
        }

        await sleep(50);
      }
    };
    await shown(devtools, "swf2es://app/");

    let inspector: DevTools | null = null;
    const main = async <T>(expression: string): Promise<T> => {
      if (!inspector) {
        let address = "";
        await until("the main process's inspector", () => {
          address = /Debugger listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1] ?? "";

          return address !== "";
        });
        const other = new WebSocket(address);
        sockets.push(other);
        await new Promise((done, fail) => {
          other.addEventListener("open", done);
          other.addEventListener("error", fail);
        });
        inspector = new DevTools(other);
      }

      return evaluateOn<T>(inspector, expression);
    };

    const again = (more: string[]) =>
      new Promise<number | null>((done) => start(more).on("exit", (code) => done(code)));
    const pageOf = async (prefix: string): Promise<DevTools> => {
      let found: { webSocketDebuggerUrl: string } | undefined;
      for (let waited = 0; !found; waited += 250) {
        const listed = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        found = listed.find((t) => t.type === "page" && t.url.startsWith(prefix));
        if (!found) {
          if (exited || waited > TIMEOUT) {
            throw new Error(`a page on ${prefix}: ${exited ?? "timed out"}\nstderr:\n${stderr}`);
          }

          await sleep(250);
        }
      }

      const other = new WebSocket(found.webSocketDebuggerUrl);
      sockets.push(other);
      await new Promise((done, fail) => {
        other.addEventListener("open", done);
        other.addEventListener("error", fail);
      });
      const client = new DevTools(other);
      await shown(client, prefix);

      return client;
    };
    await run({
      stdout,
      stderr: () => stderr,
      until,
      evaluate,
      main,
      devtools,
      again,
      page: pageOf,
      userData,
    });
    // What the page's policy refused, as Chromium words it; Electron's own warning about 'unsafe-
    // eval' is not one.
    assert.doesNotMatch(stderr, /violates the following Content Security Policy/);
  } finally {
    socket?.close();
    for (const other of sockets) {
      other.close();
    }

    // Gone before its user data is: it writes there as it quits.
    const running = electron;
    if (running && running.exitCode === null && running.signalCode === null) {
      const gone = new Promise((done) => running.once("exit", done));
      running.kill();
      await gone;
    }

    rmSync(userData, { recursive: true, force: true });
  }
}
