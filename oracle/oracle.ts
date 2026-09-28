// The avmshell oracle: compiles .as files with ASC 2.0 and runs them in
// avmshell, both from the CrossBridge image (https://github.com/33TU/crossbridge),
// run with podman or docker. The image is pinned by digest so every machine
// and CI run uses the same avmshell.
//
//   node oracle/oracle.ts <file.as>...            print each file's avmshell output
//   node oracle/oracle.ts --abcdump <file.as>...  print abcdump's dump of each file
//   node oracle/oracle.ts --pull                  pull the image
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const ASC = `java -jar ${LIBRARY}/asc2.jar -import ${LIBRARY}/builtin.abc -import ${LIBRARY}/shell_toplevel.abc`;

/** Shell lines that compile abcdump into $out/tools, once. */
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

function container(engine: string, args: string[]) {
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

/**
 * What a compile depends on: the image, the arguments, and the contents of
 * the source and of every file passed with -in or -import.
 */
function compileKey(job: OracleJob): string {
  const hash = createHash("sha256")
    .update(IMAGE)
    .update("\0")
    .update((job.ascArgs ?? []).join(" "));
  const args = job.ascArgs ?? [];
  const inputs = [
    job.source,
    ...args.filter((_, i) => args[i - 1] === "-in" || args[i - 1] === "-import"),
  ];
  for (const file of inputs) {
    const path = resolve(root, file);
    hash
      .update("\0")
      .update(file)
      .update("\0")
      .update(existsSync(path) ? readFileSync(path) : "");
  }

  return hash.digest("hex");
}

/**
 * Compile and run each job in one container, so the image starts once per
 * batch, with `parallel` jobs at a time. An ABC whose compile key (see
 * compileKey) is unchanged is reused instead of recompiled. With `abcdump`,
 * each ABC is also dumped; with `repeat`, it runs twice to find output that
 * changes from run to run. Each avmshell run gets `timeoutSeconds`.
 */
export function runOracle(
  jobs: (string | OracleJob)[],
  outDir: string,
  {
    engine = containerEngine(),
    timeoutSeconds = 20,
    abcdump = false,
    repeat = false,
    parallel = defaultParallelism(),
  } = {},
): OracleResult[] {
  mkdirSync(join(outDir, "tools"), { recursive: true });

  const rel = (p: string) => relative(root, resolve(p));
  const out = rel(outDir);
  if (out.startsWith("..")) {
    throw new Error(`outDir must be inside ${root}`);
  }

  if (abcdump && !existsSync(join(root, ABCDUMP_SOURCE))) {
    throw new Error(`${ABCDUMP_SOURCE} is missing; run git submodule update --init`);
  }

  const all = jobs.map((j) => (typeof j === "string" ? { source: j } : j));
  const names = new Set<string>();
  const lines = all.map((job) => {
    const name = job.name ?? basename(job.source, ".as");
    if (basename(name) !== basename(job.source, ".as")) {
      throw new Error(`Job ${name} must end with the base name of ${job.source}`);
    }

    if (names.has(name)) {
      throw new Error(`Two jobs are named ${name}`);
    }

    names.add(name);
    const cached =
      existsSync(join(outDir, `${name}.abc`)) &&
      existsSync(join(outDir, `${name}.key`)) &&
      readFileSync(join(outDir, `${name}.key`), "utf8") === compileKey(job);
    return [name, rel(job.source), cached ? "0" : "1", (job.ascArgs ?? []).join(" ")].join("\t");
  });

  const avmshell = `timeout ${timeoutSeconds} /opt/crossbridge/sdk/usr/bin/avmshell`;
  const script = [
    `out="${out}"`,
    ...(abcdump ? buildAbcdump : []),
    "job() {",
    `  IFS=$'\t' read -r n f compile args <<< "$1"`,
    `  d=$(dirname "$out/$n")`,
    `  mkdir -p "$d"`,
    `  rm -f "$out/$n.code" "$out/$n.out" "$out/$n.out2" "$out/$n.dump"`,
    `  if [ "$compile" = 1 ]; then`,
    `    rm -f "$out/$n.abc" "$out/$n.key"`,
    `    ${ASC} $args -outdir "$d" "$f" > "$out/$n.log" 2>&1`,
    "  fi",
    `  if [ -f "$out/$n.abc" ]; then`,
    // Run from the job's own directory: tests may write files, which then stay in outDir.
    `    b=$(basename "$n")`,
    `    (cd "$d" && ${avmshell} "$b.abc" > "$b.out" 2>&1; echo $? > "$b.code")`,
    ...(repeat ? [`    (cd "$d" && ${avmshell} "$b.abc" > "$b.out2" 2>&1)`] : []),
    ...(abcdump
      ? [`    (cd "$d" && ${avmshell} "/work/$out/tools/abcdump.abc" -- "$b.abc" > "$b.dump" 2>&1)`]
      : []),
    "  fi",
    // Results are read from the files; an avmshell error must not fail xargs.
    "  return 0",
    "}",
    "export -f job",
    "export out",
    `xargs -a "$out/jobs.tsv" -d '\n' -P ${parallel} -I{} bash -c 'job "$1"' _ {}`,
  ].join("\n");

  writeFileSync(join(outDir, "jobs.tsv"), `${lines.join("\n")}\n`);
  writeFileSync(join(outDir, "run.sh"), `${script}\n`);

  const r = container(engine, [`${out}/run.sh`]);
  if (r.status !== 0) {
    throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);
  }

  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };

  // The JVM announces _JAVA_OPTIONS on every run.
  const clean = (log: string) => log.replace(/^Picked up _JAVA_OPTIONS:.*\n/m, "");

  return all.map((job, i) => {
    const [name, , compile] = lines[i].split("\t");
    const n = join(outDir, name);
    const code = read(`${n}.code`);
    const output = read(`${n}.out`) ?? "";

    if (compile === "1") {
      if (existsSync(`${n}.abc`)) {
        writeFileSync(`${n}.key`, compileKey(job));
      } else {
        rmSync(`${n}.key`, { force: true });
      }
    }

    return {
      file: rel(job.source),
      name,
      compiled: code !== null,
      compileLog: clean(read(`${n}.log`) ?? ""),
      exitCode: code === null ? null : Number(code),
      output,
      dump: abcdump && code !== null ? read(`${n}.dump`) : null,
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
 * repository.
 */
export function libraries(
  names: string[],
  outDir: string,
  { engine = containerEngine() } = {},
): Library[] {
  mkdirSync(join(outDir, "tools"), { recursive: true });
  const out = relative(root, resolve(outDir));
  if (out.startsWith("..")) {
    throw new Error(`outDir must be inside ${root}`);
  }

  const script = [
    `out="${out}"`,
    ...buildAbcdump,
    ...names.flatMap((n) => [
      `cp ${LIBRARY}/${n}.abc "$out/${n}.abc"`,
      `(cd "$out" && /opt/crossbridge/sdk/usr/bin/avmshell tools/abcdump.abc -- ${n}.abc > ${n}.dump 2>&1)`,
    ]),
  ].join("\n");
  writeFileSync(join(outDir, "libraries.sh"), `${script}\n`);

  const r = container(engine, [`${out}/libraries.sh`]);
  if (r.status !== 0) {
    throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);
  }

  return names.map((name) => ({
    name,
    abc: new Uint8Array(readFileSync(join(outDir, `${name}.abc`))),
    dump: readFileSync(join(outDir, `${name}.dump`), "utf8"),
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
