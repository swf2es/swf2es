// The avmshell oracle: compiles .as files with ASC 2.0 and runs them in
// avmshell, both from the CrossBridge image (https://github.com/33TU/crossbridge),
// run with podman or docker. The image is pinned by digest so every machine
// and CI run uses the same avmshell.
//
//   node oracle/oracle.ts <file.as>...            print each file's avmshell output
//   node oracle/oracle.ts --abcdump <file.as>...  print abcdump's dump of each file
//   node oracle/oracle.ts --pull                  pull the image
import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDoAbc, readSwf, tags } from "../packages/format/dist/index.js";
import { put, stored, take } from "./store.ts";

export const IMAGE =
  "ghcr.io/33tu/crossbridge@sha256:486ae832869e84cc25be62d3332ffffde64a8d42cd415f0a3346dddc5c98d84c";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** One .as file to compile and run. */
export interface OracleJob {
  source: string;
  /**
   * Where the outputs go, relative to outDir and without extension; it must
   * end with the source's base name, which is how ASC names its output.
   * Defaults to that base name.
   */
  name?: string;
  /**
   * Extra ASC 2.0 arguments, such as -AS3, -strict or -in helper.as. File paths
   * must be relative to the repository root: that is what the container sees.
   */
  ascArgs?: string[];
  /** Arguments avmshell runs the ABC with, such as -api AIR_1_5 for AIR's series of API versions. */
  shellArgs?: string[];
}

export interface OracleResult {
  /** Path of the .as file, relative to the repository root. */
  file: string;
  /** The job's name: its outputs are <outDir>/<name>.abc, .log, .out, .code and .dump. */
  name: string;
  /** Whether ASC 2.0 produced an .abc; avmshell runs only if it did. */
  compiled: boolean;
  /** ASC 2.0 output: errors and warnings. */
  compileLog: string;
  /** avmshell exit code, or null if the file did not compile. 124 is a timeout. */
  exitCode: number | null;
  /** avmshell stdout and stderr: the trace output to compare against. */
  output: string;
  /** abcdump's dump of the .abc, when requested and the file compiled. */
  dump: string | null;
  /** With `repeat`: whether a second avmshell run printed something else. */
  nondeterministic: boolean;
}

/** avmplus' ABC disassembler, run in avmshell; the oracle for our ABC parser. */
const ABCDUMP_SOURCE = "oracle/avmplus/utils/abcdump.as";

/** Where the image keeps the ABCs ASC imports: builtin, shell_toplevel, playerglobal... */
const LIBRARY = "/opt/crossbridge/sdk/usr/lib";
/**
 * The libraries taken from the avmplus submodule's generated/ instead, newer than the image's
 * (docs/architecture/runtime.md).
 */
const SUBMODULE_LIBRARIES = ["builtin", "shell_toplevel"];

/** ASC 2.0 with the image's library ABCs `imports` on its path, builtin first. */
function ascCommand(imports: string[]): string {
  return `java -jar ${LIBRARY}/asc2.jar ${imports.map((n) => `-import ${LIBRARY}/${n}.abc`).join(" ")}`;
}

/** The libraries avmshell's programs compile against; a player's compile against playerglobal instead. */
const SHELL_IMPORTS = ["builtin", "shell_toplevel"];

const ASC = ascCommand(SHELL_IMPORTS);

/**
 * Shell lines that compile abcdump into $out/tools when it is not there.
 * abcdumpTool puts the store's copy there first, or removes a stale one,
 * and storeAbcdump keeps a new one.
 */
const buildAbcdump = [
  `if [ ! -f "$out/tools/abcdump.abc" ]; then`,
  `  ${ASC} -outdir "$out/tools" ${ABCDUMP_SOURCE} > "$out/tools/abcdump.log" 2>&1`,
  "fi",
];

/**
 * Jobs at a time: $SWF2ES_ORACLE_JOBS, or up to 10, since each is a JVM and
 * more makes a laptop sluggish.
 */
function defaultParallelism(): number {
  const forced = Number(process.env.SWF2ES_ORACLE_JOBS);
  if (forced > 0) {
    return forced;
  }

  return Math.min(10, availableParallelism());
}

/** podman or docker, or $SWF2ES_CONTAINER if set. */
export function containerEngine(): string {
  const forced = process.env.SWF2ES_CONTAINER;
  if (forced) {
    return forced;
  }

  for (const engine of ["podman", "docker"]) {
    if (spawnSync(engine, ["--version"], { stdio: "ignore" }).status === 0) {
      return engine;
    }
  }

  throw new Error("The avmshell oracle needs podman or docker");
}

/**
 * Run the image with `args`. Without an `engine`, one is found only now, so
 * a run that the store answers whole needs no podman or docker.
 */
export function container(given: string | undefined, args: string[]) {
  const engine = given ?? containerEngine();
  // Keep files written into the mounted repo owned by the calling user.
  const user =
    engine === "podman"
      ? ["--userns=keep-id"]
      : [`--user=${process.getuid?.()}:${process.getgid?.()}`];

  // The image gives every JVM a 6 GB heap; ASC needs far less, and many run at once.
  // Dates print in UTC wherever the oracle runs.
  const env = ["-e", "HOME=/tmp", "-e", "TZ=UTC", "-e", "_JAVA_OPTIONS=-Xms64m -Xmx768m"];

  // A shared SELinux label (z, not Z): a private one would lock out any other
  // oracle container using the repo at the same time.
  return spawnSync(
    engine,
    ["run", "--rm", ...user, ...env, "-v", `${root}:/work:z`, "-w", "/work"].concat([
      "--entrypoint",
      "bash",
      IMAGE,
      ...args,
    ]),
    { encoding: "utf8", maxBuffer: 1 << 30 },
  );
}

export function pull(engine = containerEngine()): void {
  const r = spawnSync(engine, ["pull", IMAGE], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`${engine} pull failed`);
  }
}

/** A path relative to the repository root, as the container sees it. */
const rel = (p: string) => relative(root, resolve(p));

/** A key made of a list of strings. */
function keyOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/**
 * Hash `file`, a path relative to the repository root, and every file it
 * `include`s, which ASC reads relative to the including file.
 */
function hashSource(hash: Hash, file: string, seen = new Set<string>()): void {
  if (seen.has(file)) {
    return;
  }

  seen.add(file);
  const path = resolve(root, file);
  const contents = existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null;
  hash
    .update("\0")
    .update(file)
    .update("\0")
    .update(contents ?? "");
  if (!contents || !file.endsWith(".as")) {
    return;
  }

  for (const [, included] of contents.toString("utf8").matchAll(INCLUDE)) {
    hashSource(hash, relative(root, resolve(dirname(path), included)), seen);
  }
}

const INCLUDE = /^\s*include\s+["']([^"']+)["']/gm;

/**
 * What a compile depends on: the image, the arguments, the contents of the
 * source and of every file passed with -in or -import, with what they
 * include, and `output`, the outputs' path without extension, which ASC's
 * log names. Paths are the repository's, so every checkout computes the
 * same key and shares the store's entry (store.ts).
 */
function compileKey(job: OracleJob, imports: string[], output: string): string {
  const hash = createHash("sha256")
    .update(IMAGE)
    .update("\0")
    .update((job.ascArgs ?? []).join(" "))
    .update("\0")
    .update(imports.join(" "))
    .update("\0")
    .update(output);
  const args = job.ascArgs ?? [];
  const inputs = [
    rel(job.source),
    ...args.filter((_, i) => args[i - 1] === "-in" || args[i - 1] === "-import"),
  ];
  const seen = new Set<string>();
  for (const file of inputs) {
    hashSource(hash, file, seen);
  }

  return hash.digest("hex");
}

/**
 * Whether a compile that made nothing failed for good: ASC exited with its
 * own error status and counted its errors. Anything else, as a JVM killed
 * for want of memory, may succeed on another try, so it is not stored.
 */
function failedForGood(status: string | null, log: string): boolean {
  const code = Number(status);
  return status !== null && code >= 1 && code < 128 && /^\d+ errors? found$/m.test(log);
}

/**
 * Make `out`/tools/abcdump.abc the one for abcdump's current key, from the
 * store if it has it (else the container builds it), and return the key,
 * which a dump's key includes. tools/abcdump.key says which it is.
 */
function abcdumpTool(out: string): string {
  const key = compileKey({ source: ABCDUMP_SOURCE }, SHELL_IMPORTS, `${out}/tools/abcdump`);
  const tool = join(root, out, "tools/abcdump");
  const current =
    existsSync(`${tool}.abc`) &&
    existsSync(`${tool}.key`) &&
    readFileSync(`${tool}.key`, "utf8") === key;
  if (!current) {
    for (const ext of [".abc", ".log", ".key"]) {
      rmSync(tool + ext, { force: true });
    }

    if (stored(key, "log") && take(key, "abc", `${tool}.abc`)) {
      take(key, "log", `${tool}.log`);
      writeFileSync(`${tool}.key`, key);
    }
  }

  return key;
}

/**
 * Keep the abcdump ABC a container built in `out`/tools, and say whether
 * there is one: a dump made without it is only its error.
 */
function storeAbcdump(out: string, key: string): boolean {
  const tool = join(root, out, "tools/abcdump");
  if (!existsSync(`${tool}.abc`)) {
    return false;
  }

  if (!existsSync(`${tool}.key`)) {
    put(key, "abc", `${tool}.abc`);
    put(key, "log", `${tool}.log`);
    writeFileSync(`${tool}.key`, key);
  }

  return true;
}

/**
 * Compile and run each job in one container, so the image starts once per
 * batch, with `parallel` jobs at a time. An ABC whose compile key (see
 * compileKey) is unchanged is reused instead of recompiled, from outDir or
 * else from the store shared by every checkout (store.ts). With `abcdump`,
 * each ABC is also dumped, or the dump taken from the store; with `repeat`,
 * it runs twice to find output that changes from run to run. Each avmshell
 * run gets `timeoutSeconds`. `imports` names the image's library ABCs to
 * compile against, and with `run` false nothing runs: for a SWF's script,
 * compiled against playerglobal, which avmshell has no natives for, or to
 * compile only. No container starts when nothing is left to do in one.
 */
export function runOracle(
  jobs: (string | OracleJob)[],
  outDir: string,
  {
    engine = undefined as string | undefined,
    timeoutSeconds = 20,
    abcdump = false,
    repeat = false,
    parallel = defaultParallelism(),
    imports = SHELL_IMPORTS,
    run = true,
  } = {},
): OracleResult[] {
  const asc = ascCommand(imports);
  mkdirSync(join(outDir, "tools"), { recursive: true });

  const out = rel(outDir);
  if (out.startsWith("..")) {
    throw new Error(`outDir must be inside ${root}`);
  }

  if (abcdump && !existsSync(join(root, ABCDUMP_SOURCE))) {
    throw new Error(`${ABCDUMP_SOURCE} is missing; run git submodule update --init`);
  }

  const abcdumpKey = abcdump ? abcdumpTool(out) : "";
  const all = jobs.map((j) => (typeof j === "string" ? { source: j } : j));
  const names = new Set<string>();
  const plan = all.map((job) => {
    const name = job.name ?? basename(job.source, ".as");
    if (basename(name) !== basename(job.source, ".as")) {
      throw new Error(`Job ${name} must end with the base name of ${job.source}`);
    }

    if (names.has(name)) {
      throw new Error(`Two jobs are named ${name}`);
    }

    names.add(name);
    const n = join(outDir, name);
    const key = compileKey(job, imports, `${out}/${name}`);
    let compile =
      !existsSync(`${n}.abc`) ||
      !existsSync(`${n}.key`) ||
      readFileSync(`${n}.key`, "utf8") !== key;
    // The log is stored last, so with it the entry is whole.
    if (compile && stored(key, "log")) {
      if (take(key, "abc", `${n}.abc`)) {
        writeFileSync(`${n}.key`, key);
      } else {
        rmSync(`${n}.abc`, { force: true });
        rmSync(`${n}.key`, { force: true });
      }

      take(key, "log", `${n}.log`);
      compile = false;
    }

    const dumpKey = keyOf(key, abcdumpKey);
    const dump = abcdump && (compile || (existsSync(`${n}.abc`) && !stored(dumpKey, "dump")));
    const line = [name, rel(job.source), compile ? "1" : "0", dump ? "1" : "0"];
    return {
      job,
      name,
      key,
      dumpKey,
      compile,
      dump,
      // A field bash's read would not skip if empty, as it skips empty fields between tabs.
      line: [...line, (job.shellArgs ?? []).join(" ") || "-", (job.ascArgs ?? []).join(" ")],
    };
  });

  const avmshell = `timeout ${timeoutSeconds} /opt/crossbridge/sdk/usr/bin/avmshell`;
  const script = [
    `out="${out}"`,
    ...(plan.some((p) => p.dump) ? buildAbcdump : []),
    "job() {",
    `  IFS=$'\t' read -r n f compile dump shell args <<< "$1"`,
    `  [ "$shell" = - ] && shell=""`,
    `  d=$(dirname "$out/$n")`,
    `  mkdir -p "$d"`,
    `  rm -f "$out/$n.code" "$out/$n.out" "$out/$n.out2" "$out/$n.dump"`,
    `  if [ "$compile" = 1 ]; then`,
    // Removed, not overwritten: the old files may be links to the store's.
    `    rm -f "$out/$n.abc" "$out/$n.key" "$out/$n.log" "$out/$n.status"`,
    `    ${asc} $args -outdir "$d" "$f" > "$out/$n.log" 2>&1; echo $? > "$out/$n.status"`,
    "  fi",
    `  if [ -f "$out/$n.abc" ]; then`,
    // Run from the job's own directory: tests may write files, which then stay in outDir.
    `    b=$(basename "$n")`,
    ...(run
      ? [`    (cd "$d" && ${avmshell} $shell "$b.abc" > "$b.out" 2>&1; echo $? > "$b.code")`]
      : []),
    ...(repeat && run ? [`    (cd "$d" && ${avmshell} $shell "$b.abc" > "$b.out2" 2>&1)`] : []),
    `    if [ "$dump" = 1 ]; then`,
    `      (cd "$d" && ${avmshell} "/work/$out/tools/abcdump.abc" -- "$b.abc" > "$b.dump" 2>&1)`,
    "    fi",
    "  fi",
    // Results are read from the files; an avmshell error must not fail xargs.
    "  return 0",
    "}",
    "export -f job",
    "export out",
    `xargs -a "$out/jobs.tsv" -d '\n' -P ${parallel} -I{} bash -c 'job "$1"' _ {}`,
  ].join("\n");

  writeFileSync(join(outDir, "jobs.tsv"), `${plan.map((p) => p.line.join("\t")).join("\n")}\n`);
  writeFileSync(join(outDir, "run.sh"), `${script}\n`);

  if (run || plan.some((p) => p.compile || p.dump)) {
    const r = container(engine, [`${out}/run.sh`]);
    if (r.status !== 0) {
      throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);
    }
  } else {
    // What the script would have removed.
    for (const { name } of plan) {
      for (const ext of [".code", ".out", ".out2", ".dump"]) {
        rmSync(join(outDir, name + ext), { force: true });
      }
    }
  }

  const dumper = abcdump && storeAbcdump(out, abcdumpKey);

  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };

  // The JVM announces _JAVA_OPTIONS on every run.
  const clean = (log: string) => log.replace(/^Picked up _JAVA_OPTIONS:.*\n/m, "");

  return plan.map(({ job, name, key, dumpKey, compile, dump: dumped }) => {
    const n = join(outDir, name);
    const code = read(`${n}.code`);
    const output = read(`${n}.out`) ?? "";
    const log = read(`${n}.log`) ?? "";
    const compiled = existsSync(`${n}.abc`);

    if (compile) {
      if (compiled) {
        writeFileSync(`${n}.key`, key);
        put(key, "abc", `${n}.abc`);
      } else {
        rmSync(`${n}.key`, { force: true });
      }

      if (existsSync(`${n}.log`) && (compiled || failedForGood(read(`${n}.status`), log))) {
        put(key, "log", `${n}.log`);
      }
    }

    if (abcdump && compiled) {
      if (dumped) {
        if (dumper && existsSync(`${n}.dump`)) {
          put(dumpKey, "dump", `${n}.dump`);
        }
      } else {
        take(dumpKey, "dump", `${n}.dump`);
      }
    }

    return {
      file: rel(job.source),
      name,
      compiled: run ? code !== null : compiled,
      compileLog: clean(log),
      exitCode: code === null ? null : Number(code),
      output,
      dump: abcdump && compiled ? read(`${n}.dump`) : null,
      nondeterministic: repeat && code !== null && read(`${n}.out2`) !== output,
    };
  });
}

/** One of the image's library ABCs, copied out, and abcdump's dump of it. */
export interface Library {
  name: string;
  abc: Uint8Array;
  dump: string;
}

/**
 * Copy library ABCs (such as "builtin" or "playerglobal") out of the image
 * into outDir and dump each with abcdump. They are what ASC compiles
 * against; playerglobal and airglobal are Adobe's, so they stay out of the
 * repository. Each ABC and dump is kept in the store (store.ts), so that
 * when all are there no container starts.
 */
export function libraries(
  names: string[],
  outDir: string,
  { engine = undefined as string | undefined } = {},
): Library[] {
  mkdirSync(join(outDir, "tools"), { recursive: true });
  const out = rel(outDir);
  if (out.startsWith("..")) {
    throw new Error(`outDir must be inside ${root}`);
  }

  const abcdumpKey = abcdumpTool(out);
  // The standard library is the submodule's own; the player's and AIR's declarations are the image's.
  const source = (n: string) =>
    SUBMODULE_LIBRARIES.includes(n) ? `oracle/avmplus/generated/${n}.abc` : `${LIBRARY}/${n}.abc`;
  const keys = names.map((n) => {
    const file = join(root, source(n));
    const contents = SUBMODULE_LIBRARIES.includes(n) && existsSync(file) ? readFileSync(file) : "";
    return keyOf(
      IMAGE,
      source(n),
      createHash("sha256").update(contents).digest("hex"),
      abcdumpKey,
      `${out}/${n}`,
    );
  });
  const missing = names.filter((n, i) => {
    // The dump is stored last, so with it the entry is whole.
    if (!stored(keys[i], "dump")) {
      return true;
    }

    take(keys[i], "abc", join(outDir, `${n}.abc`));
    take(keys[i], "dump", join(outDir, `${n}.dump`));
    return false;
  });

  if (missing.length) {
    const script = [
      `out="${out}"`,
      ...buildAbcdump,
      ...missing.flatMap((n) => [
        `rm -f "$out/${n}.abc" "$out/${n}.dump"`,
        `cp ${source(n)} "$out/${n}.abc"`,
        `(cd "$out" && /opt/crossbridge/sdk/usr/bin/avmshell tools/abcdump.abc -- ${n}.abc > ${n}.dump 2>&1)`,
      ]),
    ].join("\n");
    writeFileSync(join(outDir, "libraries.sh"), `${script}\n`);

    const r = container(engine, [`${out}/libraries.sh`]);
    if (r.status !== 0) {
      throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);
    }

    // A dump made without abcdump's ABC is only its error.
    const dumper = storeAbcdump(out, abcdumpKey);
    for (const n of dumper ? missing : []) {
      const i = names.indexOf(n);
      put(keys[i], "abc", join(outDir, `${n}.abc`));
      put(keys[i], "dump", join(outDir, `${n}.dump`));
    }
  }

  return names.map((name) => ({
    name,
    abc: new Uint8Array(readFileSync(join(outDir, `${name}.abc`))),
    dump: readFileSync(join(outDir, `${name}.dump`), "utf8"),
  }));
}

/** avmshell's run of one ABC. */
export interface AbcRun {
  exitCode: number;
  output: string;
}

/**
 * Run each ABC in avmshell, from `outDir` (inside the repository), in one
 * container: no compiling, for ABCs built by hand.
 */
export function runAbcs(
  abcs: Uint8Array[],
  outDir: string,
  { engine = undefined as string | undefined, timeoutSeconds = 20 } = {},
): AbcRun[] {
  mkdirSync(outDir, { recursive: true });
  const out = relative(root, resolve(outDir));
  if (out.startsWith("..")) {
    throw new Error(`outDir must be inside ${root}`);
  }

  for (const [i, bytes] of abcs.entries()) {
    writeFileSync(join(outDir, `${i}.abc`), bytes);
  }

  const script = [
    `cd "${out}"`,
    `for i in $(seq 0 ${abcs.length - 1}); do`,
    `  timeout ${timeoutSeconds} /opt/crossbridge/sdk/usr/bin/avmshell $i.abc > $i.out 2>&1; echo $? > $i.code`,
    "done",
  ].join("\n");
  writeFileSync(join(outDir, "run.sh"), `${script}\n`);

  const r = container(engine, [`${out}/run.sh`]);
  if (r.status !== 0) {
    throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);
  }

  return abcs.map((_, i) => ({
    exitCode: Number(readFileSync(join(outDir, `${i}.code`), "utf8")),
    output: readFileSync(join(outDir, `${i}.out`), "utf8"),
  }));
}

/** A C program to build with the image's Crossbridge and run as its avmshell projector. */
export interface CrossbridgeJob {
  /** Where the outputs go, relative to outDir: <name> (the projector), .abc, .log, .out, .code and .dump. */
  name: string;
  /** Sources and gcc's arguments, as paths relative to the repository root: what the container sees. */
  gccArgs: string[];
}

export interface CrossbridgeResult {
  name: string;
  compiled: boolean;
  compileLog: string;
  exitCode: number | null;
  output: string;
  /** The program's ABC, out of the projector: what swf2es runs. */
  abc: Uint8Array | null;
  /** abcdump's dump of the ABC. */
  dump: string | null;
}

/**
 * What a build depends on: the image, gcc's arguments, and every file they
 * name, as themselves or after an = (-flto-api=exports.txt), or that sits in
 * a directory they put on the include path; and `output`, where the
 * projector goes. Paths are the repository's, as in compileKey.
 */
function crossbridgeKey(job: CrossbridgeJob, output: string): string {
  const hash = createHash("sha256")
    .update(IMAGE)
    .update("\0")
    .update(job.gccArgs.join(" "))
    .update("\0")
    .update(output);
  for (const arg of job.gccArgs) {
    const named = arg.startsWith("-I")
      ? arg.slice(2)
      : arg.startsWith("-")
        ? arg.split("=")[1]
        : arg;
    const path = named ? resolve(root, named) : "";
    const files =
      !path || !existsSync(path)
        ? []
        : statSync(path).isDirectory()
          ? readdirSync(path)
              .sort()
              .map((f) => join(path, f))
              .filter((f) => statSync(f).isFile())
          : [path];
    for (const f of files) {
      hash.update("\0").update(relative(root, f)).update("\0").update(readFileSync(f));
    }
  }

  return hash.digest("hex");
}

/**
 * The ABC of a Crossbridge projector: an avmshell binary with a SWF after
 * it, then the SWF's length and 0xfa123456, little-endian, and 4 bytes of
 * zeros; the SWF's one DoABC is the program.
 */
function projectorAbc(projector: Uint8Array): Uint8Array {
  const view = new DataView(projector.buffer, projector.byteOffset, projector.byteLength);
  const end = projector.length - 4;
  if (view.getUint32(end - 8, true) !== 0xfa123456) {
    throw new Error("not a Crossbridge projector");
  }

  const length = view.getUint32(end - 4, true);
  const swf = readSwf(projector.subarray(end - 8 - length, end - 8));
  const tag = swf.tags.find((t) => t.code === tags.DoABC || t.code === tags.DoABC2);
  if (!tag) {
    throw new Error("a Crossbridge projector without a DoABC");
  }

  return readDoAbc(swf.bytes, tag).abc;
}

/**
 * Build each job with the image's gcc and run it, then take its ABC out of
 * the projector and dump it with abcdump, in two containers for the whole
 * batch. A projector whose build key (see crossbridgeKey) is unchanged is
 * reused, from outDir or else from the store (store.ts), and so are the
 * dumps, which need no container when all are stored. Each run gets
 * `timeoutSeconds`.
 */
export function runCrossbridge(
  jobs: CrossbridgeJob[],
  outDir: string,
  { engine = undefined as string | undefined, timeoutSeconds = 120 } = {},
): CrossbridgeResult[] {
  mkdirSync(join(outDir, "tools"), { recursive: true });
  const out = rel(outDir);
  if (out.startsWith("..")) {
    throw new Error(`outDir must be inside ${root}`);
  }

  const build = jobs.map((job) => {
    const n = join(outDir, job.name);
    const key = crossbridgeKey(job, `${out}/${job.name}`);
    let cached =
      existsSync(n) && existsSync(`${n}.key`) && readFileSync(`${n}.key`, "utf8") === key;
    if (!cached) {
      rmSync(n, { force: true });
      rmSync(`${n}.key`, { force: true });
      // The log is stored last, so with it the entry is whole.
      if (stored(key, "log")) {
        if (take(key, "projector", n)) {
          writeFileSync(`${n}.key`, key);
        }

        take(key, "log", `${n}.log`);
        cached = true;
      }
    }

    return { job, key, cached };
  });

  const run = [
    `out="${out}"`,
    ...build.flatMap(({ job, cached }) => [
      `rm -f "$out/${job.name}.out" "$out/${job.name}.code"`,
      ...(cached
        ? []
        : [
            // Removed, not overwritten: the old log may be a link to the store's.
            `rm -f "$out/${job.name}.log"`,
            `/opt/crossbridge/sdk/usr/bin/gcc ${job.gccArgs.join(" ")} -o "$out/${job.name}" > "$out/${job.name}.log" 2>&1`,
          ]),
      `if [ -f "$out/${job.name}" ]; then`,
      `  timeout ${timeoutSeconds} "$out/${job.name}" > "$out/${job.name}.out" 2>&1; echo $? > "$out/${job.name}.code"`,
      "fi",
    ]),
  ].join("\n");
  writeFileSync(join(outDir, "crossbridge.sh"), `${run}\n`);
  let r = container(engine, [`${out}/crossbridge.sh`]);
  if (r.status !== 0) {
    throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);
  }

  const abcdumpKey = abcdumpTool(out);
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const results = build.map(({ job, key, cached }) => {
    const n = join(outDir, job.name);
    const compiled = existsSync(n);
    const log = read(`${n}.log`);
    // Only a build that succeeded is stored: a failed one's log cannot tell
    // an error in the program from clang killed for want of memory.
    if (!cached && compiled) {
      writeFileSync(`${n}.key`, key);
      put(key, "projector", n);
      put(key, "log", `${n}.log`);
    }

    const abc = compiled ? projectorAbc(new Uint8Array(readFileSync(n))) : null;
    if (abc) {
      writeFileSync(`${n}.abc`, abc);
    }

    const code = read(`${n}.code`);
    return {
      name: job.name,
      compiled,
      compileLog: log ?? "",
      exitCode: code === null ? null : Number(code),
      output: read(`${n}.out`) ?? "",
      abc,
      dump: null as string | null,
      dumpKey: keyOf(key, abcdumpKey),
    };
  });

  const missing = results.filter(
    (x) => x.abc && !take(x.dumpKey, "dump", join(outDir, `${x.name}.dump`)),
  );
  if (missing.length) {
    const dump = [
      `out="${out}"`,
      ...buildAbcdump,
      ...missing.map(
        (x) =>
          `(cd "$out" && rm -f "${x.name}.dump" && /opt/crossbridge/sdk/usr/bin/avmshell tools/abcdump.abc -- "${x.name}.abc" > "${x.name}.dump" 2>&1)`,
      ),
    ].join("\n");
    writeFileSync(join(outDir, "crossbridge-dump.sh"), `${dump}\n`);
    r = container(engine, [`${out}/crossbridge-dump.sh`]);
    if (r.status !== 0) {
      throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);
    }

    if (storeAbcdump(out, abcdumpKey)) {
      for (const x of missing) {
        put(x.dumpKey, "dump", join(outDir, `${x.name}.dump`));
      }
    }
  }

  return results.map(({ dumpKey: _, ...x }) => ({
    ...x,
    dump: x.abc ? read(join(outDir, `${x.name}.dump`)) : null,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);

  const abcdump = args[0] === "--abcdump";
  const files = abcdump ? args.slice(1) : args;

  if (args[0] === "--pull") {
    pull();
  } else if (!files.length) {
    console.error("usage: node oracle/oracle.ts [--abcdump] <file.as>... | --pull");
    process.exit(1);
  } else {
    for (const r of runOracle(files, join(root, "oracle/out"), { abcdump })) {
      console.log(`== ${r.file} (${r.compiled ? `exit ${r.exitCode}` : "did not compile"})`);
      process.stdout.write(r.compiled ? ((abcdump ? r.dump : r.output) ?? "") : r.compileLog);
    }
  }
}
