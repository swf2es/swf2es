// Plays SWFs in swf2es's player in headless Chrome, over the DevTools
// protocol, and gives back the frames asked for as PNGs. Chrome's software
// WebGL (SwiftShader) draws them, so the result does not depend on the
// machine's GPU. CHROME names the browser; by default google-chrome.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./serve.ts";

export interface PlayerJob {
  swf: Uint8Array;
  frames: number;
  capture: number[];
  quality?: "low" | "medium" | "high" | "best";
}

const QUALITIES = ["low", "medium", "high", "best"];

export interface PlayerResult {
  images: Map<number, Uint8Array>;
  /** What stopped the player, if anything. */
  error: string | null;
}

class DevTools {
  private id = 0;
  private readonly pending = new Map<
    number,
    (message: { result?: unknown; error?: { message: string } }) => void
  >();

  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
  }

  send<T>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) =>
      this.pending.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : ok(m.result as T))),
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run each job in the player, in one browser. */
export async function runPlayer(jobs: PlayerJob[]): Promise<PlayerResult[]> {
  const { server, url } = await serve();
  const profile = mkdtempSync(join(tmpdir(), "swf2es-chrome-"));
  let chrome: ChildProcess | null = null;
  try {
    chrome = spawn(
      process.env.CHROME ?? "google-chrome",
      [
        "--headless=new",
        "--no-sandbox",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--no-first-run",
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    // Chrome writes the port it chose into the profile.
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      try {
        port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      } catch {
        // Not yet.
      }
    }

    const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const target = targets.find((t) => t.type === "page");
    if (!target) {
      throw new Error("Chrome has no page");
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ready) => socket.addEventListener("open", ready));
    const devtools = new DevTools(socket);
    await devtools.send("Page.enable");
    await devtools.send("Runtime.enable");
    await devtools.send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      const { result } = await devtools.send<{ result: { value: boolean } }>("Runtime.evaluate", {
        expression: "typeof runSwf === 'function'",
        returnByValue: true,
      });
      if (result.value) {
        break;
      }

      await sleep(100);
    }

    const results: PlayerResult[] = [];
    for (const job of jobs) {
      const expression = `runSwf(${JSON.stringify(Buffer.from(job.swf).toString("base64"))}, ${job.frames}, ${JSON.stringify(job.capture)}, ${QUALITIES.indexOf(job.quality ?? "high")})`;
      const { result, exceptionDetails } = await devtools.send<{
        result: { value?: { images: Record<string, string>; error: string | null } };
        exceptionDetails?: { text: string };
      }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      const value = result.value;
      const images = new Map<number, Uint8Array>();
      for (const [frame, dataUrl] of Object.entries(value?.images ?? {})) {
        images.set(Number(frame), new Uint8Array(Buffer.from(dataUrl.split(",")[1], "base64")));
      }

      results.push({ images, error: value?.error ?? exceptionDetails?.text ?? null });
    }

    socket.close();
    return results;
  } finally {
    chrome?.kill("SIGKILL");
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
