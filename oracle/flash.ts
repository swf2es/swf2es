// The Flash oracle: runs SWFs in Flash, AIR's adl, and gives what they
// traced and drew. oracle/flash/Harness.as, compiled with amxmlc, runs each
// SWF in a hidden window and sends back the frames asked for as PNGs over a
// loopback socket; the traces come on adl's standard error.
//
//   node oracle/flash.ts <file.swf> [frames, default 1] [frame to capture...] [low|medium|high|best]
//   node oracle/flash.ts --root <file.swf> [frames, default 2]
//
// adl and amxmlc come from an AIR SDK on PATH, or the ADL and AMXMLC
// environment variables. An adl that runs AIR's Windows runtime under Wine
// in a flatpak sees only the home directory, so everything it reads is
// written under oracle/out/flash. AIR runs one instance of an application
// id at a time: each run gets a copy of the descriptor with an id of its own.
// Results are cached by the SWF's hash and the frames asked for;
// SWF2ES_FLASH_FRESH=1 ignores the cache.
//
// Flash runs everything at its root SWF's API version, so every SWF the
// harness loads runs at the harness's, HARNESS_SWF_VERSION's. A job run as
// the root (FlashJob.root, --root) is the application's content itself, at
// its own version, with oracle/flash/Swf2esOracleRoot.as's ABC put first
// in it to mark its traces and end it: traces only, and AS3 only.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The built package, as the tests use it: node runs its .js, not its sources.
import { backgroundColor, isAs3, readSwf, tags } from "../packages/format/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "out/flash");
const harnessSource = join(here, "flash/Harness.as");
const rootSource = join(here, "flash/Swf2esOracleRoot.as");

/**
 * The harness's SWF version, which every job it loads runs at the API
 * version of (apiVersionOf: AIR_20_0 here, Flash Player's SWF_31 in the
 * player), as Flash runs a loaded SWF at its root's.
 */
export const HARNESS_SWF_VERSION = 51;

/** A SWF to run, and the frames of it to capture (frame 1 is its first). */
export interface FlashJob {
  swf: Uint8Array;
  /** How many frames to run it for. */
  frames: number;
  /** Stage quality, as Flash's StageQuality: "low", "medium", "high" (the default) or "best". */
  quality?: string;
  capture: number[];
  /**
   * Run in an adl of its own: what it draws depends on the run before it,
   * as a read past a bitmap draws the memory another job left there.
   */
  alone?: boolean;
  /**
   * More files, by name, for what it loads by a relative URL: they go
   * beside the harness, whose URL a SWF it loads from bytes has.
   */
  files?: Record<string, Uint8Array>;
  /**
   * Run as the application's content, the root, in an adl of its own,
   * rather than loaded by the harness: at its own SWF version's API
   * version, not the harness's. Traces only: nothing is captured, the
   * quality is the SWF's, and it must be an AS3 SWF of two frames at least
   * (rootJobProblem), or it comes back incomplete with the reason among its
   * errors, unrun: its first frame's end comes before the EXIT_FRAME
   * listeners the SWF adds in that frame, which a harness job's includes.
   * An error nothing caught before its first frame ends stops it with
   * AIR's dialog, and it comes back incomplete, not run again.
   */
  root?: boolean;
}

/**
 * `name`, if it is a plain file name, which a job's or a player case's
 * file may have: letters, digits, `_`, `-` and dots, not first. Anything
 * else, a path or `..` among them, throws.
 */
export function plainFileName(name: string): string {
  if (!/^[\w-][\w.-]*$/.test(name)) {
    throw new Error(`a file of a job is named by a plain file name, not ${JSON.stringify(name)}`);
  }

  return name;
}

export interface FlashResult {
  /** The SWF's traces, one per line. */
  output: string[];
  /** Errors nothing caught, as their strings. */
  errors: string[];
  /** Each captured frame's PNG, by frame number. */
  images: Map<number, Uint8Array>;
  /** Whether the job ended before its frames had run, as a timeout or a crash. */
  incomplete: boolean;
  /** Whether its content traced after it was unloaded: it runs on, and would trace in the jobs after it. */
  leaked?: boolean;
}

const MARK = "\x01swf2es:";
const QUALITIES = ["low", "medium", "high", "best"];

function tool(name: string): string {
  return process.env[name.toUpperCase()] ?? name;
}

// Traces kept; AIR's float type off, as Flash Player content has none; the
// version pinned, as the player's cases are to it.
const HARNESS_FLAGS = [
  "-compiler.float=false",
  "-omit-trace-statements=false",
  `-swf-version=${HARNESS_SWF_VERSION}`,
];

/** `source`'s SWF, compiled again when the source or the flags change. */
function compiled(source: string, name: string): string {
  const hash = createHash("sha256")
    .update(readFileSync(source))
    .update(HARNESS_FLAGS.join(" "))
    .digest("hex")
    .slice(0, 16);
  const swf = join(out, `${name}-${hash}.swf`);
  if (!existsSync(swf)) {
    mkdirSync(out, { recursive: true });
    const result = spawnSync(tool("amxmlc"), [...HARNESS_FLAGS, "-output", swf, source], {
      encoding: "utf8",
    });
    if (!existsSync(swf)) {
      throw new Error(`amxmlc failed:\n${result.stdout}${result.stderr}`);
    }
  }

  return swf;
}

/** The harness's SWF. */
function harness(): string {
  return compiled(harnessSource, "Harness");
}

/**
 * Why `job` cannot run as the root, or null if it can: it must be an AS3
 * SWF, FileAttributes first, which runs for two frames at least and
 * captures none. In its first frame the helper's EXIT_FRAME listener, added
 * as its ABC loads, comes before those the SWF adds; it is added again at
 * that frame's end, after them, so that a job's last frame, from the
 * second on, ends as the harness's do.
 */
export function rootJobProblem(job: FlashJob): string | null {
  if (job.capture.length) {
    return "a job run as the root captures no frames";
  }

  if (job.frames < 2) {
    return "a job run as the root runs for two frames at least, or it ends before its first frame's EXIT_FRAME listeners";
  }

  try {
    const swf = readSwf(job.swf);
    if (!isAs3(swf) || swf.tags[0]?.code !== tags.FileAttributes) {
      return "a job run as the root must be an AS3 SWF, FileAttributes first";
    }
  } catch (e) {
    return `a job run as the root must be a SWF: ${(e as Error).message}`;
  }

  return null;
}

/**
 * `swf` with Swf2esOracleRoot's ABC first, after its FileAttributes, as a
 * DoABC that runs as it loads (no lazy flag), uncompressed. It must be a
 * SWF rootJobProblem passes.
 */
function withRootScript(swf: Uint8Array): Uint8Array {
  const job = readSwf(swf);
  const first = job.tags[0];

  const helper = readSwf(new Uint8Array(readFileSync(compiled(rootSource, "Swf2esOracleRoot"))));
  const doAbc = helper.tags.find((t) => t.code === tags.DoABC2);
  if (!doAbc) {
    throw new Error("amxmlc gave Swf2esOracleRoot no DoABC");
  }

  // DoABC2: u32 flags, a name ending in 0, the ABC.
  const body = helper.bytes.subarray(doAbc.offset, doAbc.offset + doAbc.length);
  const abc = body.subarray(body.indexOf(0, 4) + 1);
  const name = Buffer.from("swf2es-oracle-root\0", "latin1");
  const tag = Buffer.alloc(6 + 4 + name.length);
  tag.writeUInt16LE((tags.DoABC2 << 6) | 0x3f, 0);
  tag.writeUInt32LE(4 + name.length + abc.length, 2);
  name.copy(tag, 10);

  const at = first.offset + first.length;
  const result = Buffer.concat([job.bytes.subarray(0, at), tag, abc, job.bytes.subarray(at)]);
  result.write("FWS", 0, "latin1");
  result.writeUInt32LE(result.length, 4);
  return new Uint8Array(result);
}

/**
 * An application of `content`; with `size`, its window 550 by 400, which
 * the harness sizes to each SWF, else the SWF's own.
 */
function descriptor(content: string, id: string, size = true): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>${id}</id>
  <filename>swf2es-harness</filename>
  <versionNumber>0.1.0</versionNumber>
  <initialWindow>
    <content>${content}</content>
    <visible>false</visible>${size ? "\n    <width>550</width>\n    <height>400</height>" : ""}
    <renderMode>cpu</renderMode>
    <!-- Without it AIR keeps high quality where a SWF asks for low or medium. -->
    <allowLowQuality>true</allowLowQuality>
  </initialWindow>
  <supportedProfiles>extendedDesktop</supportedProfiles>
  <diagnostics><traceToConsole>true</traceToConsole></diagnostics>
</application>
`;
}

/**
 * A job's cache key: what decides what Flash gives for it, the adl it runs
 * in among it: the harness, or for a job run as the root the helper, which
 * takes no quality. A job run alone is keyed apart, and one not, as before;
 * and the zone where TZ names one, which adl under Wine takes Flash's
 * local time from.
 */
export function jobKey(job: FlashJob): string {
  const hash = createHash("sha256");
  for (const [name, bytes] of Object.entries(job.files ?? {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    hash.update(`file ${name} ${bytes.length}\n`).update(bytes);
  }

  hash.update(job.swf);
  if (job.root) {
    hash.update(`\n${job.frames}\nroot\n${readFileSync(rootSource)}`);
  } else {
    hash.update(
      `\n${job.frames}\n${job.quality ?? "high"}\n${job.capture.join(",")}\n${readFileSync(harnessSource)}`,
    );
  }

  return hash
    .update(job.alone ? "\nalone" : "")
    .update(process.env.TZ ? `\nTZ=${process.env.TZ}` : "")
    .digest("hex");
}

function encodeJob(id: number, job: FlashJob): Buffer {
  const swf = readSwf(job.swf);
  const width = Math.round((swf.frameSize.xMax - swf.frameSize.xMin) / 20);
  const height = Math.round((swf.frameSize.yMax - swf.frameSize.yMin) / 20);
  const head = Buffer.alloc(21 + job.capture.length * 2 + 4);
  let at = head.writeUInt32LE(id, 0);
  at = head.writeUInt32LE(backgroundColor(swf), at);
  at = head.writeUInt16LE(width, at);
  at = head.writeUInt16LE(height, at);
  at = head.writeFloatLE(frameRate(job.swf), at);
  at = head.writeUInt8(Math.max(0, QUALITIES.indexOf(job.quality ?? "high")), at);
  at = head.writeUInt16LE(job.frames, at);
  at = head.writeUInt16LE(job.capture.length, at);
  for (const frame of job.capture) {
    at = head.writeUInt16LE(frame, at);
  }

  head.writeUInt32LE(job.swf.length, at);
  return Buffer.concat([head, job.swf]);
}

/**
 * Run a job as the root in an adl of its own, until it traces its end and
 * quits, or `timeout` ms pass without its output. One that cannot run so
 * (rootJobProblem) comes back incomplete, unrun, the reason its error.
 */
async function runRoot(job: FlashJob, timeout: number, timed: boolean): Promise<FlashResult> {
  const result: FlashResult = { output: [], errors: [], images: new Map(), incomplete: true };
  const problem = rootJobProblem(job);
  if (problem) {
    result.errors.push(problem);
    return result;
  }

  const id = `swf2es-root-${process.pid}-${Date.now()}`;
  const app = join(out, `${id}.xml`);
  const content = join(out, `${id}.swf`);
  mkdirSync(out, { recursive: true });
  writeFileSync(content, withRootScript(job.swf));
  writeFileSync(app, descriptor(`${id}.swf`, id, false));

  let adl: ChildProcess | null = null;
  try {
    const flags = timed ? ["-nodebug"] : [];
    adl = spawn(tool("adl"), [...flags, `${id}.xml`, ".", "--", String(job.frames)], {
      cwd: out,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let traces = "";
    adl.stdout?.resume();
    const running = adl;
    await new Promise<void>((done) => {
      // From its last output: a loaded machine slows adl's start and frames alike.
      let timer = setTimeout(done, timeout);
      running.stderr?.setEncoding("utf8").on("data", (d: string) => {
        traces += d;
        clearTimeout(timer);
        timer = setTimeout(done, timeout);
      });
      running.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    splitOutput(traces, [result]);
    result.incomplete = !traces.includes(`${MARK}end 0`);
    // AIR prints what stopped it, before the helper's mark where the ABCs
    // did not verify: its error, as the job's.
    if (result.incomplete) {
      const stopped = traces.split("\n").find((line) => ERROR_LINE.test(line));
      if (stopped && !result.output.includes(stopped.replace(/\r+$/, ""))) {
        result.errors.push(stopped.replace(/\r+$/, ""));
      }
    }
  } finally {
    if (adl?.pid) {
      try {
        process.kill(-adl.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }

    rmSync(app, { force: true });
    rmSync(content, { force: true });
  }

  return result;
}

/** Run the jobs in one adl, until one is `timeout` ms without word from the harness. */
async function runAdl(jobs: FlashJob[], timeout: number, timed: boolean): Promise<FlashResult[]> {
  const results: FlashResult[] = jobs.map(() => ({
    output: [],
    errors: [],
    images: new Map(),
    incomplete: true,
  }));
  const content = harness();
  const id = `swf2es-harness-${process.pid}-${Date.now()}`;
  const app = join(out, `${id}.xml`);
  writeFileSync(app, descriptor(content.slice(out.length + 1), id));

  const files = jobs.flatMap((job) => Object.entries(job.files ?? {}));
  // They share the harness's directory: one name, one file.
  const written = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    const before = written.get(name);
    if (before !== undefined && Buffer.compare(before, bytes) !== 0) {
      throw new Error(`two jobs have different files named ${name}`);
    }

    written.set(name, bytes);
    writeFileSync(join(out, plainFileName(name)), bytes);
  }

  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  let adl: ChildProcess | null = null;
  try {
    // Relative paths from oracle/out/flash: adl under Wine does not take absolute ones.
    // The debugger's bookkeeping slows the JIT's code (object creation
    // about 1.7 times): a timing runs without it, its traces as before.
    const flags = timed ? ["-nodebug"] : [];
    adl = spawn(tool("adl"), [...flags, `${id}.xml`, ".", "--", String(port)], {
      cwd: out,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // AIR under Wine traces to stderr, lines ending in \r\r\n.
    let traces = "";
    adl.stdout?.resume();
    adl.stderr?.setEncoding("utf8").on("data", (d: string) => {
      traces += d;
    });

    const connection = await new Promise<Socket>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("adl did not connect")), timeout);
      server.once("connection", (s) => {
        clearTimeout(timer);
        ok(s);
      });
    });

    await new Promise<void>((finish) => {
      // Without word from the harness for `timeout`, a job is stuck.
      let timer = setTimeout(finish, timeout);
      let input = Buffer.alloc(0);
      let remaining = jobs.length;
      connection.on("data", (data) => {
        clearTimeout(timer);
        timer = setTimeout(finish, timeout);
        input = Buffer.concat([input, data]);
        for (;;) {
          if (input.length >= 5 && input[0] === 2) {
            results[input.readUInt32LE(1)].incomplete = false;
            input = input.subarray(5);
            remaining--;
            if (remaining === 0) {
              clearTimeout(timer);
              finish();
              return;
            }
          } else if (input.length >= 11 && input[0] === 1) {
            const length = input.readUInt32LE(7);
            if (input.length < 11 + length) {
              break;
            }

            results[input.readUInt32LE(1)].images.set(
              input.readUInt16LE(5),
              new Uint8Array(input.subarray(11, 11 + length)),
            );
            input = input.subarray(11 + length);
          } else {
            break;
          }
        }
      });
      connection.on("close", () => {
        clearTimeout(timer);
        finish();
      });
      for (const [i, job] of jobs.entries()) {
        connection.write(encodeJob(i, job));
      }

      const end = Buffer.alloc(4);
      end.writeUInt32LE(0xffffffff);
      connection.write(end);
    });

    // The harness quits after the last job; its traces come out as it exits.
    const exited = adl;
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 15_000);
      exited.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    splitOutput(traces, results);
    connection.destroy();
  } finally {
    if (adl?.pid) {
      try {
        process.kill(-adl.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }

    server.close();
    rmSync(app, { force: true });
    for (const [name] of files) {
      rmSync(join(out, name), { force: true });
    }
  }

  return results;
}

/** The first line of an error AIR prints as it stops a SWF, as "VerifyError: Error #1053: ...". */
const ERROR_LINE = /^[\w.:$]*Error: /;

/** Whether a result's traces hold an error: one the helper caught, or one AIR printed as it stopped the SWF. */
function heldError(result: FlashResult): boolean {
  return result.errors.length > 0 || result.output.some((line) => ERROR_LINE.test(line));
}

/** A line of Wine's debug channels, as `0120:fixme:win:IsImmersiveProcess (FFFFFFFF): stub`, its pid first with +pid. */
const WINE_DEBUG = /^[0-9a-f]{4,}(:[0-9a-f]{4,})?:(fixme|err|warn|trace):/;

/**
 * Each job's traces, between its begin and end marks; a job leaked if
 * anything is traced after its settle mark, before the next job begins.
 */
function splitOutput(stdout: string, results: FlashResult[]): void {
  let current: FlashResult | null = null;
  let settled: FlashResult | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r+$/, "");
    // Wine's own debug lines share AIR's stderr; one written while a job
    // runs would read as its trace.
    if (WINE_DEBUG.test(line)) {
      continue;
    }

    if (line.startsWith(`${MARK}begin `)) {
      current = results[Number(line.slice(MARK.length + 6))] ?? null;
      settled = null;
    } else if (line.startsWith(`${MARK}end `)) {
      current = null;
    } else if (line.startsWith(`${MARK}settle `)) {
      settled = results[Number(line.slice(MARK.length + 7))] ?? null;
    } else if (settled && line !== "") {
      settled.leaked = true;
    } else if (line.startsWith(`${MARK}error `)) {
      current?.errors.push(line.slice(MARK.length + 6));
    } else if (current) {
      current.output.push(line);
    }
  }
}

/** A SWF's frame rate; 24 for one that does not read, as a root job that will not run. */
function frameRate(swf: Uint8Array): number {
  try {
    return readSwf(swf).frameRate || 24;
  } catch {
    return 24;
  }
}

function cachePath(key: string): string {
  return join(out, "cache", key.slice(0, 2), key);
}

function readCache(key: string): FlashResult | null {
  const dir = cachePath(key);
  if (!existsSync(join(dir, "result.json"))) {
    return null;
  }

  const saved = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  const images = new Map<number, Uint8Array>();
  for (const frame of saved.frames as number[]) {
    images.set(frame, new Uint8Array(readFileSync(join(dir, `frame-${frame}.png`))));
  }

  return { output: saved.output, errors: saved.errors, images, incomplete: saved.incomplete };
}

function writeCache(key: string, result: FlashResult): void {
  const dir = cachePath(key);
  mkdirSync(dir, { recursive: true });
  for (const [frame, png] of result.images) {
    writeFileSync(join(dir, `frame-${frame}.png`), png);
  }

  const saved = {
    output: result.output,
    errors: result.errors,
    frames: [...result.images.keys()],
    incomplete: result.incomplete,
  };
  writeFileSync(join(dir, "result.json"), JSON.stringify(saved, null, 1));
}

/**
 * Run each job in Flash, from the cache where it ran before. Uncached jobs
 * run in one adl; those after a job whose content leaked, running on after
 * it was unloaded, run again in another, clean of it. A job that sends nothing for `timeout` ms beyond its
 * frames' time comes back incomplete, and is not cached. A `timed` run, whose
 * SWFs time themselves, runs without the debugger and neither reads nor
 * writes the cache.
 */
export async function runFlash(
  jobs: FlashJob[],
  timeout = 20_000,
  { timed = false } = {},
): Promise<FlashResult[]> {
  const keys = jobs.map(jobKey);
  // SWF2ES_FLASH_FRESH=1 runs every job again, as when checking the harness.
  const fresh = timed || process.env.SWF2ES_FLASH_FRESH === "1";
  const results: (FlashResult | null)[] = keys.map((key) => (fresh ? null : readCache(key)));
  let todo = jobs.flatMap((job, i) => (results[i] ? [] : [{ job, i, tries: 0 }]));
  // A SWF that hangs or crashes Flash ends the run, and those after it run
  // again in another. It runs once more, first in the next, as adl now and then
  // stalls on a SWF that runs well alone, before it comes back incomplete.
  while (todo.length) {
    // A job that runs alone or as the root has an adl of its own; the others share one, up to it.
    const own = (job: FlashJob) => job.alone || job.root;
    const next = todo.findIndex((t, k) => k > 0 && own(t.job));
    const size = own(todo[0].job) ? 1 : next < 0 ? todo.length : next;
    const batch = todo.slice(0, size);
    const later = todo.slice(size);
    const longest = Math.max(...batch.map((t) => (t.job.frames / frameRate(t.job.swf)) * 1000));
    const ran = batch[0].job.root
      ? [await runRoot(batch[0].job, timeout + longest, timed)]
      : await runAdl(
          batch.map((t) => t.job),
          timeout + longest,
          timed,
        );
    let failed = ran.findIndex((r) => r.incomplete);
    if (failed < 0) {
      failed = batch.length;
    }

    // A job whose content ran on after it was unloaded is kept, and those
    // after it, which its content may have traced in, run again in another.
    const leaked = ran.findIndex((r) => r.leaked);
    if (leaked >= 0 && leaked < failed) {
      for (let k = 0; k <= leaked; k++) {
        const { i } = batch[k];
        results[i] = ran[k];
        if (!timed) {
          writeCache(keys[i], ran[k]);
        }
      }

      todo = [...batch.slice(leaked + 1), ...later];
      continue;
    }

    for (let k = 0; k < Math.min(failed, batch.length); k++) {
      const { i } = batch[k];
      results[i] = ran[k];
      if (!timed) {
        writeCache(keys[i], ran[k]);
      }
    }

    const rest = batch.slice(failed + 1);
    if (failed < batch.length) {
      const stalled = batch[failed];
      // A root job whose traces hold an error stopped at it, with AIR's
      // dialog, which a second run would show again; one that could not
      // run would not run again either.
      if (stalled.tries === 0 && !(stalled.job.root && heldError(ran[failed]))) {
        rest.unshift({ ...stalled, tries: 1 });
      } else {
        results[stalled.i] = ran[failed];
      }
    }

    todo = [...rest, ...later];
  }

  // Flash's log breaks a trace's lines at a carriage return as at a line
  // feed, as Ruffle's corpus has it recorded; adl's standard error keeps the
  // "\r", and writes "\r\n" for a "\n", which reads as a line's end.
  return (results as FlashResult[]).map((r) => ({
    ...r,
    output: r.output.flatMap((line) => line.split("\r")),
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = args.includes("--root");
  const [file, frames = root ? "2" : "1", ...rest] = args.filter((a) => a !== "--root");
  const quality = rest.find((a) => QUALITIES.includes(a));
  const capture = rest.filter((a) => !QUALITIES.includes(a));
  if (!file || (root && capture.length)) {
    console.error(
      "usage: node oracle/flash.ts <file.swf> [frames] [frame to capture...] [low|medium|high|best]\n" +
        "       node oracle/flash.ts --root <file.swf> [frames, 2 at least]   as the root, at its own version: traces only",
    );
    process.exit(2);
  }

  const swf = new Uint8Array(readFileSync(file));
  const job = { swf, frames: Number(frames), quality, capture: capture.map(Number), root };
  const [result] = await runFlash([job]);
  for (const line of result.output) {
    console.log(line);
  }

  for (const error of result.errors) {
    console.log(`uncaught: ${error}`);
  }

  const last = join(out, "last");
  mkdirSync(last, { recursive: true });
  for (const [frame, png] of result.images) {
    const path = join(last, `frame-${frame}.png`);
    writeFileSync(path, png);
    console.log(`frame ${frame}: ${path}`);
  }

  if (result.incomplete) {
    console.log("incomplete: the run ended before the SWF's frames had");
    process.exitCode = 1;
  }
}
