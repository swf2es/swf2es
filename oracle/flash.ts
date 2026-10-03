// The Flash oracle: runs SWFs in Flash, AIR's adl, and gives what they
// traced and drew. oracle/flash/Harness.as, compiled with amxmlc, runs each
// SWF in a hidden window and sends back the frames asked for as PNGs over a
// loopback socket; the traces come on adl's standard error.
//
//   node oracle/flash.ts <file.swf> [frames, default 1] [frame to capture...] [low|medium|high|best]
//
// adl and amxmlc come from an AIR SDK on PATH, or the ADL and AMXMLC
// environment variables. An adl that runs AIR's Windows runtime under Wine
// in a flatpak sees only the home directory, so everything it reads is
// written under oracle/out/flash. AIR runs one instance of an application
// id at a time: each run gets a copy of the descriptor with an id of its own.
// Results are cached by the SWF's hash and the frames asked for;
// SWF2ES_FLASH_FRESH=1 ignores the cache.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The built package, as the tests use it: node runs its .js, not its sources.
import { backgroundColor, readSwf } from "../packages/format/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "out/flash");
const harnessSource = join(here, "flash/Harness.as");

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

// Traces kept; AIR's float type off, as Flash Player content has none.
const HARNESS_FLAGS = ["-compiler.float=false", "-omit-trace-statements=false"];

/** The harness's SWF, compiled again when its source or its flags change. */
function harness(): string {
  const source = readFileSync(harnessSource);
  const hash = createHash("sha256")
    .update(source)
    .update(HARNESS_FLAGS.join(" "))
    .digest("hex")
    .slice(0, 16);
  const swf = join(out, `Harness-${hash}.swf`);
  if (!existsSync(swf)) {
    mkdirSync(out, { recursive: true });
    const result = spawnSync(tool("amxmlc"), [...HARNESS_FLAGS, "-output", swf, harnessSource], {
      encoding: "utf8",
    });
    if (!existsSync(swf)) {
      throw new Error(`amxmlc failed:\n${result.stdout}${result.stderr}`);
    }
  }

  return swf;
}

function descriptor(content: string, id: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>${id}</id>
  <filename>swf2es-harness</filename>
  <versionNumber>0.1.0</versionNumber>
  <initialWindow>
    <content>${content}</content>
    <visible>false</visible>
    <width>550</width>
    <height>400</height>
    <renderMode>cpu</renderMode>
    <!-- Without it AIR keeps high quality where a SWF asks for low or medium. -->
    <allowLowQuality>true</allowLowQuality>
  </initialWindow>
  <supportedProfiles>extendedDesktop</supportedProfiles>
  <diagnostics><traceToConsole>true</traceToConsole></diagnostics>
</application>
`;
}

function jobKey(job: FlashJob): string {
  return createHash("sha256")
    .update(job.swf)
    .update(
      `\n${job.frames}\n${job.quality ?? "high"}\n${job.capture.join(",")}\n${readFileSync(harnessSource)}`,
    )
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

/** Run the jobs in one adl, until one is `timeout` ms without word from the harness. */
async function runAdl(jobs: FlashJob[], timeout: number): Promise<FlashResult[]> {
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

  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  let adl: ChildProcess | null = null;
  try {
    // Relative paths from oracle/out/flash: adl under Wine does not take absolute ones.
    adl = spawn(tool("adl"), [`${id}.xml`, ".", "--", String(port)], {
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
  }

  return results;
}

/**
 * Each job's traces, between its begin and end marks; a job leaked if
 * anything is traced after its settle mark, before the next job begins.
 */
function splitOutput(stdout: string, results: FlashResult[]): void {
  let current: FlashResult | null = null;
  let settled: FlashResult | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r+$/, "");
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

function frameRate(swf: Uint8Array): number {
  return readSwf(swf).frameRate || 24;
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
 * frames' time comes back incomplete, and is not cached.
 */
export async function runFlash(jobs: FlashJob[], timeout = 20_000): Promise<FlashResult[]> {
  const keys = jobs.map(jobKey);
  // SWF2ES_FLASH_FRESH=1 runs every job again, as when checking the harness.
  const fresh = process.env.SWF2ES_FLASH_FRESH === "1";
  const results: (FlashResult | null)[] = keys.map((key) => (fresh ? null : readCache(key)));
  let todo = jobs.flatMap((job, i) => (results[i] ? [] : [{ job, i, tries: 0 }]));
  // A SWF that hangs or crashes Flash ends the run, and those after it run
  // again in another. It runs once more, first in the next, as adl now and then
  // stalls on a SWF that runs well alone, before it comes back incomplete.
  while (todo.length) {
    // A job that runs alone has an adl of its own; the others share one, up to it.
    const next = todo.findIndex((t, k) => k > 0 && t.job.alone);
    const size = todo[0].job.alone ? 1 : next < 0 ? todo.length : next;
    const batch = todo.slice(0, size);
    const later = todo.slice(size);
    const longest = Math.max(...batch.map((t) => (t.job.frames / frameRate(t.job.swf)) * 1000));
    const ran = await runAdl(
      batch.map((t) => t.job),
      timeout + longest,
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
        writeCache(keys[i], ran[k]);
      }

      todo = [...batch.slice(leaked + 1), ...later];
      continue;
    }

    for (let k = 0; k < Math.min(failed, batch.length); k++) {
      const { i } = batch[k];
      results[i] = ran[k];
      writeCache(keys[i], ran[k]);
    }

    const rest = batch.slice(failed + 1);
    if (failed < batch.length) {
      const stalled = batch[failed];
      if (stalled.tries === 0) {
        rest.unshift({ ...stalled, tries: 1 });
      } else {
        results[stalled.i] = ran[failed];
      }
    }

    todo = [...rest, ...later];
  }

  return results as FlashResult[];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, frames = "1", ...rest] = process.argv.slice(2);
  const quality = rest.find((a) => QUALITIES.includes(a));
  const capture = rest.filter((a) => !QUALITIES.includes(a));
  if (!file) {
    console.error("usage: node oracle/flash.ts <file.swf> [frames] [frame to capture...]");
    process.exit(2);
  }

  const swf = new Uint8Array(readFileSync(file));
  const job = { swf, frames: Number(frames), quality, capture: capture.map(Number) };
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
