// Plays SWFs in swf2es's player in headless Chrome, over the DevTools
// protocol, and gives back the frames asked for as PNGs. Chrome's software
// WebGL (SwiftShader) draws them, so the result does not depend on the
// machine's GPU. CHROME names the browser; by default google-chrome.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** How much larger than its size a host shows the stage (page.ts); 1 by default. */
  zoom?: number;
  /** Drawn multisampled, as a host's renderer made with `antialias: true` draws (page.ts). */
  antialias?: boolean;
  /** Drawn without the transform table (render/table.ts) where false; with it by default. */
  table?: boolean;
  /** The fewest draws a run makes through the table; its default where not given. */
  tableMinRun?: number;
  /** The stage shown at the zoom, its frames that size, rather than drawn back to its size (page.ts). */
  shown?: boolean;
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
  /** The draws the transform table made. */
  tableDraws: number;
  /** What stopped the player, if anything. */
  error: string | null;
}

/** What a call to the page answers when the page's renderer died before answering. */
const CRASHED = "the page crashed";

class DevTools {
  private id = 0;
  /** Why no call will be answered any more, once the socket has closed. */
  private closed: string | null = null;
  private readonly pending = new Map<
    number,
    (message: { result?: unknown; error?: { message: string } }) => void
  >();

  private readonly socket: WebSocket;
  /** What listens for each event, by its method. */
  readonly listeners = new Map<string, (params: Record<string, unknown>) => void>();

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      // A dead renderer answers nothing it was asked; a fresh document may be asked again.
      if (message.method === "Inspector.targetCrashed") {
        this.failAll(CRASHED);
        return;
      }

      if (message.method) {
        this.listeners.get(message.method)?.(message.params);
        return;
      }

      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
    socket.addEventListener("close", () => {
      this.closed = "the DevTools connection closed";
      this.failAll(this.closed);
    });
  }

  send<T>(method: string, params: object = {}): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(this.closed));
    }

    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) =>
      this.pending.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : ok(m.result as T))),
    );
  }

  private failAll(message: string): void {
    for (const answer of this.pending.values()) {
      answer({ error: { message } });
    }

    this.pending.clear();
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
 * in once `ready` names a function the page has defined; `fresh` loads the
 * page again, as a new document, and waits for it the same way.
 */
async function withPage<T>(
  ready: string,
  run: (
    evaluate: <R>(expression: string) => Promise<Evaluated<R>>,
    send: <R>(method: string, params?: object) => Promise<R>,
    fresh: () => Promise<void>,
    listen: (method: string, listener: (params: Record<string, unknown>) => void) => void,
  ) => Promise<T>,
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
    // Navigating answers once the new document has replaced the old, and
    // brings a crashed page back in a new renderer.
    const fresh = async () => {
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
    };
    await fresh();

    try {
      return await run(
        async <R>(expression: string) => {
          const { result, exceptionDetails } = await devtools.send<{
            result: { value?: R };
            exceptionDetails?: { text: string };
          }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
          return { value: result.value, exception: exceptionDetails?.text ?? null };
        },
        (method, params) => devtools.send(method, params),
        fresh,
        (method, listener) => devtools.listeners.set(method, listener),
      );
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
 * Jobs one document runs before the next gets a fresh one, so that what
 * jobs leave behind in a document cannot add up over a whole run: when
 * the player imported each job's code as modules, which a document keeps
 * while it lives, some 5 MB a corpus test ran the renderer out of heap
 * after about 400 of them. leak.ts checks that a job leaves little now.
 */
const JOBS_PER_DOCUMENT = 100;

/** How long past its timeout a job may go unanswered before its page is given up on. */
const GRACE = 10_000;

/** What a job's evaluation rejects with when it is still unanswered past its timeout and GRACE. */
const UNANSWERED = "no answer";

/** `answer`, or a rejection with `late` once `ms` pass without one. */
function within<T>(answer: Promise<T>, ms: number, late: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(late)), ms);
  });
  return Promise.race([answer, expired]).finally(() => clearTimeout(timer));
}

/**
 * Run each job in the player, in one browser. With a timeout, in ms, a
 * job's script that runs longer is stopped, its error "timeout", and the
 * jobs after it run on, as they do after a job whose page crashed (its
 * error the crash's), each in a fresh document; `onResult` hears each as
 * it comes.
 */
export function runPlayer(jobs: PlayerJob[], options: RunOptions = {}): Promise<PlayerResult[]> {
  return withPage(
    "runSwf",
    async (evaluate, _send, fresh) => {
      const results: PlayerResult[] = [];
      let run = 0;
      // A document a job crashed or left running is of no use to the next.
      let stale = false;
      for (const [index, job] of jobs.entries()) {
        if (stale || run === JOBS_PER_DOCUMENT) {
          await fresh();
          run = 0;
          stale = false;
        }

        run++;
        let value:
          | {
              images: Record<string, string>;
              trace: string[];
              tableDraws: number;
              error: string | null;
            }
          | undefined;
        let exception: string | null = null;
        const begun = performance.now();
        try {
          const answer = evaluate<NonNullable<typeof value>>(
            `runSwf(${JSON.stringify(Buffer.from(job.swf).toString("base64"))}, ${job.frames}, ${JSON.stringify(job.capture)}, ${QUALITIES.indexOf(job.quality ?? "high")}, ${JSON.stringify(job.url ?? null)}, ${job.zoom ?? 1}, ${job.antialias ?? false}, ${job.table ?? true}, ${job.tableMinRun}, ${job.shown ?? false})`,
          );
          // The timeout stops a script that runs on, not one awaiting what never comes.
          ({ value, exception } = await (options.timeout
            ? within(answer, options.timeout + GRACE, UNANSWERED)
            : answer));
        } catch (e) {
          // A job stopped at the timeout makes the protocol answer with an
          // error ("Internal error"), not a result; so does one whose page
          // crashed or that went unanswered, and the next gets a fresh
          // document. Any other error is the browser's or the protocol's,
          // and stops the run.
          const message = e instanceof Error ? e.message : String(e);
          if (message === CRASHED) {
            exception = CRASHED;
            stale = true;
          } else if (message === UNANSWERED) {
            exception = "timed out";
            stale = true;
          } else if (!options.timeout || performance.now() - begun < options.timeout) {
            throw e;
          } else {
            exception = "timed out";
          }
        }

        const images = new Map<number, Uint8Array>();
        for (const [frame, dataUrl] of Object.entries(value?.images ?? {})) {
          images.set(Number(frame), new Uint8Array(Buffer.from(dataUrl.split(",")[1], "base64")));
        }

        const error =
          value?.error ?? (exception?.includes("timed out") ? "timeout" : exception) ?? null;
        const result = {
          images,
          trace: value?.trace ?? [],
          tableDraws: value?.tableDraws ?? 0,
          error,
        };
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
  /** Each frame's draw calls, rebuilds, tessellation, uploads and program switches (page.ts, meter). */
  meters: Record<string, number>[];
  /** Bytes allocated in the frames' tick, sync and render, sampled, with `allocs`. */
  allocated: number;
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

/** A node of a sampled heap profile: what was allocated under a call, and the calls under it. */
interface SampledNode {
  callFrame: { functionName: string };
  selfSize: number;
  children: SampledNode[];
}

/**
 * What a bench's frames allocated: the samples under the frame loop's
 * tick, prepare and render, not the player's start, which compiles.
 */
function framesAllocated(head: SampledNode): number {
  const frameCalls = new Set(["tick", "prepare", "render"]);
  const sum = (node: SampledNode, inBench: boolean, inFrame: boolean): number => {
    const name = node.callFrame.functionName;
    const bench = inBench || name === "benchSwf";
    const frame = inFrame || (bench && frameCalls.has(name));
    let bytes = frame ? node.selfSize : 0;
    for (const child of node.children) {
      bytes += sum(child, bench, frame);
    }

    return bytes;
  };

  return sum(head, false, false);
}

/**
 * Play `swf` for `frames` frames in the player, timing each; see page.ts's
 * benchSwf. `gpu` lets Chrome use one. With `allocs`, `profilePath` keeps
 * the sampled heap profile, as a .heapprofile DevTools opens.
 */
export function benchPlayer(
  swf: Uint8Array,
  frames: number,
  gpu = false,
  backBuffer = false,
  idleRenders = 0,
  toggle = -1,
  antialias = false,
  toggleEvery = 1,
  nestedGroups = false,
  allocs = false,
  table = true,
  tableMinRun?: number,
  profilePath?: string,
): Promise<BenchResult> {
  return withPage(
    "benchSwf",
    async (evaluate, send) => {
      if (allocs) {
        await send("HeapProfiler.enable");
        await send("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }

      const { value, exception } = await evaluate<BenchResult>(
        `benchSwf(${JSON.stringify(Buffer.from(swf).toString("base64"))}, ${frames}, ${backBuffer}, ${idleRenders}, ${toggle}, ${antialias}, ${toggleEvery}, ${nestedGroups}, ${table}, ${tableMinRun})`,
      );
      if (value && allocs) {
        const { profile } = await send<{ profile: { head: SampledNode } }>(
          "HeapProfiler.stopSampling",
        );
        value.allocated = framesAllocated(profile.head);
        if (profilePath) {
          writeFileSync(profilePath, JSON.stringify(profile));
        }
      }

      return (
        value ?? {
          counts: {},
          meters: [],
          allocated: 0,
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

/** A page for leak.ts: a SWF opened and played in steps, a job run whole, and the heap measured between. */
export interface SteppedPage {
  /** Start a SWF at `url` on the page, letting go of any opened before; what stopped it, if anything. */
  open(swf: Uint8Array, url: string): Promise<string | null>;
  /** Play the opened SWF until it has traced `lines` lines or played `frames` frames. */
  step(
    lines: number,
    frames: number,
  ): Promise<{ lines: number; codegen: number; error: string | null }>;
  /** Play a SWF for a frame, as runPlayer does a job; what stopped it, if anything. */
  run(swf: Uint8Array, url: string): Promise<string | null>;
  /** What the opened SWF has traced, a line each. */
  trace(): Promise<string[]>;
  /** Let go of the SWF opened. */
  close(): Promise<void>;
  /** The JS heap in use after a full collection, in bytes. */
  heap(): Promise<number>;
  /** A heap snapshot written to `path`, for DevTools' Memory panel to open. */
  snapshot(path: string): Promise<void>;
}

export function withSteppedPage<T>(
  run: (page: SteppedPage) => Promise<T>,
  options: RunOptions = {},
): Promise<T> {
  return withPage(
    "stepSwf",
    async (evaluate, send, _fresh, listen) => {
      const answer = async <R>(expression: string): Promise<R> => {
        const { value, exception } = await evaluate<R>(expression);
        if (exception !== null || value === undefined) {
          throw new Error(exception ?? "no answer");
        }

        return value;
      };
      const base64 = (swf: Uint8Array) => JSON.stringify(Buffer.from(swf).toString("base64"));
      return run({
        open: (swf, url) => answer(`openSwf(${base64(swf)}, ${JSON.stringify(url)})`),
        step: (lines, frames) => answer(`stepSwf(${lines}, ${frames})`),
        trace: () => answer("traceSwf()"),
        close: async () => {
          await answer("closeSwf()");
        },
        run: async (swf, url) =>
          (
            await answer<{ error: string | null }>(
              `runSwf(${base64(swf)}, 1, [], 2, ${JSON.stringify(url)})`,
            )
          ).error,
        heap: async () => {
          // Twice: what the first collection's finalizers let go goes in the second.
          await send("HeapProfiler.collectGarbage");
          await send("HeapProfiler.collectGarbage");
          return (await send<{ usedSize: number }>("Runtime.getHeapUsage")).usedSize;
        },
        snapshot: async (path) => {
          const chunks: string[] = [];
          listen("HeapProfiler.addHeapSnapshotChunk", (params) =>
            chunks.push(String(params.chunk)),
          );
          await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
          writeFileSync(path, chunks.join(""));
        },
      });
    },
    false,
    options,
  );
}
