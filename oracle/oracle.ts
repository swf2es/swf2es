// The avmshell oracle: compiles .as files with ASC 2.0 and runs them in
// avmshell, both from the CrossBridge image (https://github.com/33TU/crossbridge),
// run with podman or docker. The image is pinned by digest so every machine
// and CI run uses the same avmshell.
//
//   node oracle/oracle.ts <file.as>...   print each file's avmshell output
//   node oracle/oracle.ts --pull         pull the image
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE =
  "ghcr.io/33tu/crossbridge@sha256:486ae832869e84cc25be62d3332ffffde64a8d42cd415f0a3346dddc5c98d84c";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface OracleResult {
  /** Path of the .as file, relative to the repository root. */
  file: string;
  compiled: boolean;
  /** ASC 2.0 output: errors and warnings. */
  compileLog: string;
  /** avmshell exit code, or null if the file did not compile. 124 is a timeout. */
  exitCode: number | null;
  /** avmshell stdout and stderr: the trace output to compare against. */
  output: string;
}

/** podman or docker, or $SWF2ES_CONTAINER if set. */
export function containerEngine(): string {
  const forced = process.env.SWF2ES_CONTAINER;
  if (forced) return forced;
  for (const engine of ["podman", "docker"])
    if (spawnSync(engine, ["--version"], { stdio: "ignore" }).status === 0) return engine;
  throw new Error("The avmshell oracle needs podman or docker");
}

function container(engine: string, args: string[]) {
  // Keep files written into the mounted repo owned by the calling user.
  const user =
    engine === "podman"
      ? ["--userns=keep-id"]
      : [`--user=${process.getuid?.()}:${process.getgid?.()}`];
  return spawnSync(
    engine,
    ["run", "--rm", ...user, "-e", "HOME=/tmp", "-v", `${root}:/work:Z`, "-w", "/work"].concat([
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
  if (r.status !== 0) throw new Error(`${engine} pull failed`);
}

/**
 * Compile and run each .as file in one container, so the image starts once
 * per batch. Outputs land in `outDir` as <name>.abc, .log, .out and .code.
 * Each avmshell run gets `timeoutSeconds`.
 */
export function runOracle(
  files: string[],
  outDir: string,
  { engine = containerEngine(), timeoutSeconds = 20 } = {},
): OracleResult[] {
  mkdirSync(outDir, { recursive: true });
  const rel = (p: string) => relative(root, resolve(p));
  const out = rel(outDir);
  if (out.startsWith("..")) throw new Error(`outDir must be inside ${root}`);
  const script = [
    "L=/opt/crossbridge/sdk/usr/lib",
    `while IFS= read -r f; do`,
    `  n=$(basename "$f" .as)`,
    `  java -jar $L/asc2.jar -import $L/builtin.abc -import $L/shell_toplevel.abc \\`,
    `    -outdir "${out}" "$f" > "${out}/$n.log" 2>&1`,
    `  if [ -f "${out}/$n.abc" ]; then`,
    `    timeout ${timeoutSeconds} /opt/crossbridge/sdk/usr/bin/avmshell "${out}/$n.abc" > "${out}/$n.out" 2>&1`,
    `    echo $? > "${out}/$n.code"`,
    "  fi",
    `done < "${out}/files.txt"`,
  ].join("\n");
  const names = new Set<string>();
  for (const f of files) {
    const n = basename(f, ".as");
    if (names.has(n)) throw new Error(`Two files are named ${n}.as; run them in separate batches`);
    names.add(n);
  }
  writeFileSync(join(outDir, "files.txt"), `${files.map(rel).join("\n")}\n`);
  writeFileSync(join(outDir, "run.sh"), `${script}\n`);
  const r = container(engine, [`${out}/run.sh`]);
  if (r.status !== 0) throw new Error(`Oracle container failed (${r.status}): ${r.stderr}`);

  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  // The JVM announces _JAVA_OPTIONS from the image on every run.
  const clean = (log: string) => log.replace(/^Picked up _JAVA_OPTIONS:.*\n/m, "");
  return files.map((f) => {
    const n = join(outDir, basename(f, ".as"));
    const code = read(`${n}.code`);
    return {
      file: rel(f),
      compiled: code !== null,
      compileLog: clean(read(`${n}.log`) ?? ""),
      exitCode: code === null ? null : Number(code),
      output: read(`${n}.out`) ?? "",
    };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--pull") pull();
  else if (!args.length) {
    console.error("usage: node oracle/oracle.ts <file.as>... | --pull");
    process.exit(1);
  } else {
    for (const r of runOracle(args, join(root, "oracle/out"))) {
      console.log(`== ${r.file} (${r.compiled ? `exit ${r.exitCode}` : "did not compile"})`);
      process.stdout.write(r.compiled ? r.output : r.compileLog);
    }
  }
}
