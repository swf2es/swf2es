// Builds vendor/pixijs, the swf2es fork of PixiJS, into what swf2es takes of
// it: lib/ (the modules and declarations that "pixi.js" and its subpaths
// resolve to, ES and CommonJS as in the npm package), dist/pixi.mjs (the
// bundle the test pages and the desktop app import) and
// dist/packages/unsafe-eval.js (Pixi's polyfills for a page without
// 'unsafe-eval'). It runs the fork's own rollup configuration and
// declaration build, as its scripts/build.mts does, but leaves out the
// bundles nothing here loads (minified ones, the other plugins', the
// webworker build) and the bundled pixi.js.d.ts.
//
//   node tools/pixijs.ts [--force]
//
// A build is skipped when the fork's commit, its uncommitted changes, the
// lockfile and this file are those of the last one (lib/.swf2es-build); --force builds
// anyway. The bundles' "Compiled" date is the fork commit's, not the
// clock's, so a build is the same each time.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const pixi = fileURLToPath(new URL("../vendor/pixijs/", import.meta.url));
const stampFile = join(pixi, "lib/.swf2es-build");

// What swf2es loads of the bundles; any other output is dropped.
const BUNDLES = ["dist/pixi.mjs", "dist/packages/unsafe-eval.js"];

/** The subset of rollup's options this script reads or changes. */
interface Output {
  dir?: string;
  file?: string;
  banner?: string;
}

interface Options {
  input: unknown;
  output: (Output | false)[];
  onwarn?: (warning: { message: string }) => void;
}

interface Rollup {
  rollup(options: Options): Promise<{
    write(output: Output): Promise<unknown>;
    close(): Promise<void>;
  }>;
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", pixi, ...args], { encoding: "utf8" });
}

/** What the build depends on: the fork's commit and changes, its tools' versions and this script. */
function sourceKey(): string {
  const hash = createHash("sha256");
  hash.update(git("rev-parse", "HEAD"));
  hash.update(git("diff", "HEAD"));
  for (const path of git("ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
    if (path !== "") {
      hash.update(path);
      hash.update(readFileSync(join(pixi, path)));
    }
  }

  hash.update(readFileSync(join(pixi, "../../pnpm-lock.yaml")));
  hash.update(readFileSync(self));
  return hash.digest("hex");
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: pixi, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function outputPath(output: Output): string {
  return relative(pixi, output.file ?? output.dir ?? "");
}

/** The fork's rollup builds, narrowed to lib/ and BUNDLES. */
async function rollupBuilds(compiled: string): Promise<Options[]> {
  // The configuration resolves its paths against the working directory.
  process.chdir(pixi);
  const config = pathToFileURL(join(pixi, ".configs/rollup.config.mjs")).href;
  // It exports a promise of the builds.
  const builds: Options[] = await (await import(config)).default;
  const kept: Options[] = [];
  for (const build of builds) {
    const outputs = build.output.filter(
      (output): output is Output =>
        output !== false && (outputPath(output) === "lib" || BUNDLES.includes(outputPath(output))),
    );
    if (outputs.length === 0) {
      continue;
    }

    for (const output of outputs) {
      output.banner = output.banner?.replace(/Compiled .*/, `Compiled ${compiled}`);
    }

    kept.push({ ...build, output: outputs });
  }

  return kept;
}

async function bundle(rollup: Rollup, build: Options): Promise<void> {
  const warnings: string[] = [];
  const result = await rollup.rollup({
    ...build,
    onwarn: (warning) => warnings.push(warning.message),
  });
  for (const output of build.output) {
    if (output !== false) {
      await result.write(output);
    }
  }

  await result.close();

  // As the fork's build runs rollup, with --failAfterWarnings.
  if (warnings.length > 0) {
    throw new Error(`rollup warned:\n${warnings.join("\n")}`);
  }
}

/** Copies src/'s hand-written declarations beside the generated ones, as copyfiles does. */
function copyDeclarations(dir: string): void {
  for (const entry of readdirSync(join(pixi, "src", dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      copyDeclarations(path);
    } else if (entry.name.endsWith(".d.ts")) {
      mkdirSync(dirname(join(pixi, "lib", path)), { recursive: true });
      copyFileSync(join(pixi, "src", path), join(pixi, "lib", path));
    }
  }
}

/**
 * The fork's declaration build without types/Jest.d.ts, which needs jest's
 * types and declares nothing lib/ exports. Its tsconfig lies under
 * node_modules/ so that it finds the same @types packages.
 */
function declarationConfig(): string {
  const dir = join(pixi, "node_modules/.cache/swf2es");
  const up = "../../..";
  const config = {
    extends: `${up}/.configs/tsconfig.types.json`,
    include: [`${up}/src`, `${up}/types`],
    exclude: [
      `${up}/src/bundle.*`,
      `${up}/src/**/__tests__`,
      `${up}/src/**/__docs__/examples`,
      `${up}/types/Jest.d.ts`,
    ],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsconfig.types.json"), JSON.stringify(config, null, 2));
  return join(dir, "tsconfig.types.json");
}

async function declarations(): Promise<void> {
  await run(join(pixi, "node_modules/.bin/tsc"), ["-p", declarationConfig()]);
  copyDeclarations("");
  await run(process.execPath, ["scripts/types/fixTypes.mts"]);
}

async function main(): Promise<void> {
  if (!existsSync(join(pixi, "package.json"))) {
    throw new Error("vendor/pixijs is empty: run git submodule update --init");
  }

  const key = sourceKey();
  const built =
    existsSync(stampFile) &&
    readFileSync(stampFile, "utf8") === key &&
    BUNDLES.every((path) => existsSync(join(pixi, path)));
  if (built && !process.argv.includes("--force")) {
    console.log("pixi.js: up to date");
    return;
  }

  rmSync(join(pixi, "lib"), { recursive: true, force: true });
  rmSync(join(pixi, "dist"), { recursive: true, force: true });

  const compiled = new Date(git("log", "-1", "--format=%cI").trim()).toUTCString();
  const rollupUrl = pathToFileURL(join(pixi, "node_modules/rollup/dist/es/rollup.js")).href;
  const rollup: Rollup = await import(rollupUrl);
  const builds = await rollupBuilds(compiled.replace("GMT", "UTC"));
  await Promise.all([declarations(), ...builds.map((build) => bundle(rollup, build))]);

  writeFileSync(stampFile, key);
  console.log(`pixi.js: built lib/ and ${BUNDLES.join(", ")}`);
}

await main();
