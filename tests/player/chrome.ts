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
  /** The SWF's URL on the served page, for what it loads by relative URL; the player's default otherwise. */
  url?: string;
}

/** How to run jobs: a time each job's scripts may take, a listener for each result, and more directories to serve. */
export interface RunOptions {
  timeout?: number;
  onResult?: (index: number, result: PlayerResult) => void;
  mounts?: [string, string][];
  /** Let Chrome use the machine's GPU, as the bench's --gpu does; software GL otherwise. */
  gpu?: boolean;
}

const QUALITIES = ["low", "medium", "high", "best"];

export interface PlayerResult {
  images: Map<number, Uint8Array>;
  /** What the SWF's scripts traced, a line each. */
  trace: string[];
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

/** What `Runtime.evaluate` gives: the value, or what threw. */
interface Evaluated<T> {
  value?: T;
  exception: string | null;
}

/**
 * One headless Chrome on the served page, for `run` to evaluate expressions
 * in once `ready` names a function the page has defined.
 */
async function withPage<T>(
  ready: string,
  run: (evaluate: <R>(expression: string) => Promise<Evaluated<R>>) => Promise<T>,
  gpu = false,
  options: RunOptions = {},
): Promise<T> {
  const { timeout, mounts } = options;
  const { server, url } = await serve(mounts);
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
        // Software GL draws the same on any machine; a GPU draws as a user's
        // would. Headless Chrome reaches one here through ANGLE's Vulkan back
        // end (its GL back end gave no WebGL at all); SWF2ES_GPU_FLAGS can
        // name another. The bench prints which renderer drew either way.
        ...(gpu
          ? (process.env.SWF2ES_GPU_FLAGS ?? "--ignore-gpu-blocklist --use-angle=vulkan").split(" ")
          : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
        "--no-first-run",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    // What Chrome says and whether it is still there, for when it gives no port.
    let stderr = "";
    chrome.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    let exited: string | null = null;
    chrome.on("exit", (code, signal) => {
      exited = `exit ${code ?? signal}`;
    });
    chrome.on("error", (e) => {
      exited = e.message;
    });

    // Chrome writes the port it chose into the profile; a CI runner's cold
    // start has taken more than 10 s, so wait up to a minute, or until it dies.
    let port = "";
    for (let i = 0; i < 600 && !port && !exited; i++) {
      await sleep(100);
      try {
        port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      } catch {
        // Not yet.
      }
    }

    if (!port) {
      throw new Error(
        `Chrome gave no DevTools port (${exited ?? "still running after 60 s"})${stderr ? `:\n${stderr.trim()}` : ""}`,
      );
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
    await new Promise((open) => socket.addEventListener("open", open));
    const devtools = new DevTools(socket);
    await devtools.send("Page.enable");
    await devtools.send("Runtime.enable");
    await devtools.send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      const { result } = await devtools.send<{ result: { value: boolean } }>("Runtime.evaluate", {
        expression: `typeof ${ready} === 'function'`,
        returnByValue: true,
      });
      if (result.value) {
        break;
      }

      await sleep(100);
    }

    try {
      return await run(async <R>(expression: string) => {
        const { result, exceptionDetails } = await devtools.send<{
          result: { value?: R };
          exceptionDetails?: { text: string };
        }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
        return { value: result.value, exception: exceptionDetails?.text ?? null };
      });
    } finally {
      socket.close();
    }
  } finally {
    chrome?.kill("SIGKILL");
    server.close();
    // Chrome may still be writing its profile as it dies: a few tries.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Run each job in the player, in one browser. With a timeout, in ms, a
 * job's script that runs longer is stopped, its error "timeout", and the
 * jobs after it run on; `onResult` hears each as it comes.
 */
export function runPlayer(jobs: PlayerJob[], options: RunOptions = {}): Promise<PlayerResult[]> {
  return withPage(
    "runSwf",
    async (evaluate) => {
      const results: PlayerResult[] = [];
      for (const [index, job] of jobs.entries()) {
        let value:
          | { images: Record<string, string>; trace: string[]; error: string | null }
          | undefined;
        let exception: string | null = null;
        const begun = performance.now();
        try {
          ({ value, exception } = await evaluate<NonNullable<typeof value>>(
            `runSwf(${JSON.stringify(Buffer.from(job.swf).toString("base64"))}, ${job.frames}, ${JSON.stringify(job.capture)}, ${QUALITIES.indexOf(job.quality ?? "high")}, ${JSON.stringify(job.url ?? null)})`,
          ));
        } catch (e) {
          // A job stopped at the timeout makes the protocol answer with an
          // error ("Internal error"), not a result; one that fails sooner is
          // the browser's or the protocol's, and stops the run.
          if (!options.timeout || performance.now() - begun < options.timeout) {
            throw e;
          }

          exception = "timed out";
        }

        const images = new Map<number, Uint8Array>();
        for (const [frame, dataUrl] of Object.entries(value?.images ?? {})) {
          images.set(Number(frame), new Uint8Array(Buffer.from(dataUrl.split(",")[1], "base64")));
        }

        const error =
          value?.error ?? (exception?.includes("timed out") ? "timeout" : exception) ?? null;
        const result = { images, trace: value?.trace ?? [], error };
        results.push(result);
        options.onResult?.(index, result);
      }

      return results;
    },
    options.gpu ?? false,
    options,
  );
}

/**
 * What timing a SWF in the player gave: each frame's tick, sync to Pixi,
 * Pixi's draw and GL's finish, in ms, the first frame's load and draw, and
 * which GL renderer drew.
 */
export interface BenchResult {
  counts: Record<string, number>;
  heap: [number, number];
  tick: number[];
  sync: number[];
  draw: number[];
  gl: number[];
  idle: number[];
  first: number;
  renderer: string;
  error: string | null;
}

/** Play `swf` for `frames` frames in the player, timing each; see page.ts's benchSwf. `gpu` lets Chrome use one. */
export function benchPlayer(
  swf: Uint8Array,
  frames: number,
  gpu = false,
  backBuffer = false,
  idleRenders = 0,
  toggle = -1,
): Promise<BenchResult> {
  return withPage(
    "benchSwf",
    async (evaluate) => {
      const { value, exception } = await evaluate<BenchResult>(
        `benchSwf(${JSON.stringify(Buffer.from(swf).toString("base64"))}, ${frames}, ${backBuffer}, ${idleRenders}, ${toggle})`,
      );
      return (
        value ?? {
          counts: {},
          heap: [0, 0],
          tick: [],
          sync: [],
          draw: [],
          gl: [],
          idle: [],
          first: 0,
          renderer: "",
          error: exception ?? "no result",
        }
      );
    },
    gpu,
  );
}
