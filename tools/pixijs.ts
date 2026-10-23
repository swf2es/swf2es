// Builds vendor/pixijs, the swf2es fork of PixiJS, into what swf2es takes of
// it: lib/ (the modules and declarations that "pixi.js" and its subpaths
// resolve to, ES and CommonJS as in the npm package) and the bundle the test
// pages and the desktop app import, dist/pixi.mjs with its chunks and
// dist/packages/unsafe-eval.mjs (Pixi's polyfills for a page without
// 'unsafe-eval'). lib/ comes from the fork's own rollup configuration and
// declaration build, as its scripts/build.mts does, leaving out the bundled
// pixi.js.d.ts. The bundle is swf2es's own: the fork's plugins over an entry
// that exports only BROWSER_EXPORTS and registers only what the player draws
// with (BROWSER_INITS), tree-shaken, where Pixi's bundles take the whole
// library untouched.
//
//   node tools/pixijs.ts [--force]
//
// A build is skipped when the fork's commit, its uncommitted changes, the
// lockfile and this file are those of the last one (lib/.swf2es-build) and
// the bundle's files it wrote are all still there; --force builds
// anyway. The bundle's "Compiled" date is the fork commit's, not the
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
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const pixi = fileURLToPath(new URL("../vendor/pixijs/", import.meta.url));
const stampFile = join(pixi, "lib/.swf2es-build");

// The bundle's entries: what the pages import, as "pixi.js" and for Pixi's polyfills.
const BUNDLES = ["dist/pixi.mjs", "dist/packages/unsafe-eval.mjs"];

/**
 * What the player, @swf2es/web and the test page import from "pixi.js" as
 * values; the bundle exports these alone, and a unit test holds the list to
 * what those sources import. The rest of Pixi is in the bundle only as far
 * as these reach it.
 */
export const BROWSER_EXPORTS = [
  "AlphaFilter",
  "BatchableGraphics",
  "BatchableSprite",
  "Batcher",
  "BatcherPipe",
  "BigPool",
  "BlendModeFilter",
  "Buffer",
  "BufferImageSource",
  "BufferUsage",
  "CanvasTextMetrics",
  "Container",
  "ExtensionType",
  "Filter",
  "FilterSystem",
  "Geometry",
  "GlProgram",
  "GpuGraphicsContext",
  "GpuProgram",
  "Graphics",
  "GraphicsContext",
  "GraphicsContextRenderData",
  "GraphicsContextSystem",
  "GraphicsPipe",
  "Matrix",
  "Mesh",
  "MeshGeometry",
  "Rectangle",
  "RenderGroupSystem",
  "RenderTexture",
  "RendererType",
  "Shader",
  "Sprite",
  "State",
  "Text",
  "Texture",
  "TexturePool",
  "TextureSource",
  "UniformGroup",
  "autoDetectRenderer",
  "color32BitToUniform",
  "compileHighShaderGlProgram",
  "compileHighShaderGpuProgram",
  "extensions",
  "fastGlobalBoundsHooks",
  "fontStringFromTextStyle",
  "generateTextureBatchBit",
  "generateTextureBatchBitGl",
  "getBatchSamplersUniformGroup",
  "localUniformBitGl",
  "roundPixelsBit",
  "roundPixelsBitGl",
];

/**
 * The modules of the fork's src/ the bundle runs for their side effects, in
 * the order Pixi's own bundle runs them, which is the order a renderer's
 * systems and pipes take and are called in. They are those of
 * environment-browser/browserAll.ts, which Pixi's bundle runs and
 * autoDetectRenderer imports, but for accessibility/init (an overlay for
 * screen readers that takes the Tab key, which Flash content handles
 * itself), dom/init (DOMContainer) and spritesheet/init (an Assets loader),
 * none of which the player uses; Pixi's environment extensions, which
 * would import that file, are left out with them. Then the inits of the
 * display objects the player draws, which their classes import too but
 * later, and the WebGL renderer, which autoDetectRenderer would import()
 * only after the player's extensions had registered. The WebGPU and Canvas
 * renderers, which the player falls back to only without WebGL, stay
 * behind their import()s, in chunks loaded only then.
 */
const BROWSER_INITS = [
  "events/init",
  "rendering/init",
  "filters/init",
  "scene/graphics/init",
  "scene/mesh/init",
  "scene/text/init",
  "rendering/renderers/gl/WebGLRenderer",
];

const ENTRY = "\0swf2es:pixi";
const LIBRARY = "\0swf2es:pixi-library";

/** The subset of rollup's options this script reads or changes. */
interface Output {
  dir?: string;
  file?: string;
  banner?: string;
  format?: string;
  entryFileNames?: string;
  chunkFileNames?: string;
  freeze?: boolean;
  sourcemap?: boolean;
  manualChunks?: unknown;
}

interface Resolved {
  id: string;
  external?: boolean | string;
  moduleSideEffects?: boolean | string;
}

interface PluginContext {
  resolve(id: string, importer: string | undefined, options: object): Promise<Resolved | null>;
}

interface Plugin {
  name: string;
  options?(this: PluginContext, options: { plugins: unknown[] }): unknown;
  resolveId?(
    this: PluginContext,
    id: string,
    importer: string | undefined,
    options: object,
  ): Promise<string | Resolved | null>;
  load?(this: PluginContext, id: string): unknown;
}

interface Options {
  input: unknown;
  output: (Output | false)[];
  plugins?: unknown[];
  treeshake?: boolean;
  preserveEntrySignatures?: string;
  onwarn?: (warning: { message: string }) => void;
}

interface Chunk {
  type: string;
  fileName: string;
  name?: string;
  imports?: string[];
  isEntry?: boolean;
  modules?: Record<string, unknown>;
}

interface Rollup {
  rollup(options: Options): Promise<{
    generate(output: Output): Promise<{ output: Chunk[] }>;
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
  hash.update(git("diff", "--binary", "HEAD"));
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

/**
 * The entry's modules: ENTRY runs BROWSER_INITS and exports BROWSER_EXPORTS
 * from LIBRARY, which is src/index.ts's exports without its side effects
 * (its inits and Pixi's environment extensions).
 */
function entryPlugin(): Plugin {
  const src = (path: string) => JSON.stringify(join(pixi, "src", path));
  const index = readFileSync(join(pixi, "src/index.ts"), "utf8");
  const library = [...index.matchAll(/^export \* from '\.\/([\w-]+)';$/gm)]
    .map(([, dir]) => `export * from ${src(`${dir}/index.ts`)};`)
    .join("\n");
  const entry = [
    ...BROWSER_INITS.map((path) => `import ${src(`${path}.ts`)};`),
    `export { ${BROWSER_EXPORTS.join(", ")} } from ${JSON.stringify(LIBRARY)};`,
  ].join("\n");
  // The modules of src/ that have side effects: those Pixi's package.json
  // names under lib/, as a bundler of the npm package takes them, and
  // BROWSER_INITS. Rollup's node-resolve would read that list as it stands,
  // of lib/ paths, and so take every module of src/ to have none.
  const manifest = JSON.parse(readFileSync(join(pixi, "package.json"), "utf8"));
  const effects = new Set<string>([
    ...(manifest.sideEffects as string[]).map((path) =>
      join(pixi, path.replace(/^\.\/lib\//, "src/").replace(/\.\*$/, "")),
    ),
    ...BROWSER_INITS.map((path) => join(pixi, "src", path)),
  ]);
  const srcDir = join(pixi, "src/");
  return {
    name: "swf2es-entry",
    async resolveId(id, importer, options) {
      if (id === ENTRY || id === LIBRARY) {
        return id;
      }

      const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external || !resolved.id.startsWith(srcDir)) {
        return resolved;
      }

      return { ...resolved, moduleSideEffects: effects.has(resolved.id.replace(/\.ts$/, "")) };
    },
    load: (id) => {
      switch (id) {
        case ENTRY:
          return entry;
        case LIBRARY:
          return library;
        default:
          return null;
      }
    },
  };
}

/**
 * swf2es's bundle, in two passes. The first builds the entry alone, to
 * learn which modules load with it and which wait behind the renderers'
 * import()s. The second adds packages/unsafe-eval.mjs and keeps the first
 * pass's chunks, those that load with the entry as one file,
 * dist/pixi.mjs, where rollup would split modules by what the entries and
 * import()s share into chunks the page loads at once.
 */
async function browserBuild(rollup: Rollup, compiled: string): Promise<Options> {
  const { o, build } = await forkBuild("dist/pixi.mjs", "first");
  const banner = o.banner?.replace(/Compiled .*/, `Compiled ${compiled}`);
  const output: Output = {
    dir: join(pixi, "dist"),
    format: "es",
    entryFileNames: "[name].mjs",
    chunkFileNames: "chunks/[name]-[hash].mjs",
    banner,
    freeze: false,
    sourcemap: true,
  };
  const warnings: string[] = [];
  const first = await rollup.rollup({
    input: { pixi: ENTRY },
    output: [output],
    plugins: [entryPlugin(), ...(build.plugins ?? [])],
    treeshake: true,
    onwarn: (warning) => warnings.push(warning.message),
  });
  const generated = await first.generate(output);
  await first.close();
  if (warnings.length > 0) {
    throw new Error(`rollup warned:\n${warnings.join("\n")}`);
  }

  // The entry's chunk and those it imports statically, which load with it,
  // are one; each other chunk stays as it was. Every module is given its
  // chunk, since rollup would pull those reached from a manual chunk's
  // modules into it, and the entry's export * reaches all of Pixi.
  const byFile = new Map(generated.output.map((chunk) => [chunk.fileName, chunk]));
  const chunkOf = new Map<string, string>();
  const queue = generated.output.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const chunk = byFile.get(file);
    if (chunk && !Object.keys(chunk.modules ?? {}).some((id) => chunkOf.has(id))) {
      for (const id of Object.keys(chunk.modules ?? {})) {
        chunkOf.set(id, "pixi");
      }

      queue.push(...(chunk.imports ?? []));
    }
  }

  for (const chunk of generated.output) {
    for (const id of Object.keys(chunk.modules ?? {})) {
      if (!chunkOf.has(id)) {
        chunkOf.set(id, chunk.name ?? chunk.fileName);
      }
    }
  }

  return {
    input: {
      pixi: ENTRY,
      "packages/unsafe-eval": join(pixi, "src/unsafe-eval/init.ts"),
    },
    output: [{ ...output, manualChunks: (id: string) => chunkOf.get(id) }],
    plugins: [entryPlugin(), ...((await forkBuild("dist/pixi.mjs", "second")).build.plugins ?? [])],
    treeshake: true,
    // So that dist/pixi.mjs is that chunk, exporting what the other entry needs too, not a facade.
    preserveEntrySignatures: "allow-extension",
  };
}

/**
 * The build of the fork's rollup configuration that writes `path`, from a
 * copy of the configuration of its own, `copy`: rollup's plugins keep
 * state, which builds running at once or one after another must not share.
 */
async function forkBuild(path: string, copy: string): Promise<{ build: Options; o: Output }> {
  const result = await forkConfig(path, copy);
  let worker = 0;
  const fresh = async () =>
    (await forkConfig(path, `${copy}-worker-${++worker}`)).build.plugins ?? [];
  result.build = {
    ...result.build,
    plugins: isolatedWorkerPlugins(result.build.plugins ?? [], fresh),
  };

  return result;
}

const WORKER_PLUGIN = "@pixi/webworker-plugins/rollup-plugin";

/**
 * The worker plugin reuses its parent's plugins for nested Rollup builds.
 * Their buildStart hooks reset state still in use by the parent: CommonJS
 * can then emit proxies for exports it never generated. Each worker takes
 * a fresh configuration, with the same isolation for its own workers.
 */
export function isolatedWorkerPlugins(
  plugins: unknown[],
  fresh: () => Promise<unknown[]>,
): unknown[] {
  return plugins.map((item) => {
    const plugin = item as Plugin | undefined;
    if (plugin?.name !== WORKER_PLUGIN) {
      return item;
    }

    return {
      ...plugin,
      async load(this: PluginContext, id: string) {
        if (!id.startsWith(`\0${WORKER_PLUGIN}:`)) {
          return null;
        }

        const children = await fresh();
        const worker = children.find((p) => (p as Plugin | undefined)?.name === WORKER_PLUGIN) as
          | Plugin
          | undefined;
        if (!worker?.options || !worker.load) {
          throw new Error("the fork's worker plugin has no options or load hook");
        }

        await worker.options.call(this, { plugins: isolatedWorkerPlugins(children, fresh) });
        return worker.load.call(this, id);
      },
    };
  });
}

async function forkConfig(path: string, copy: string): Promise<{ build: Options; o: Output }> {
  // The configuration resolves its paths against the working directory.
  process.chdir(pixi);
  const config = pathToFileURL(join(pixi, ".configs/rollup.config.mjs"));
  config.search = copy;
  // It exports a promise of the builds.
  const builds: Options[] = await (await import(config.href)).default;
  for (const build of builds) {
    for (const o of build.output) {
      if (o !== false && outputPath(o) === path) {
        return { build, o };
      }
    }
  }

  fail(`the fork's rollup configuration has no build of ${path}`);
}

/** The fork's rollup build of lib/, and swf2es's bundle. */
async function rollupBuilds(rollup: Rollup, compiled: string): Promise<Options[]> {
  const lib = (await forkBuild("lib", "lib")).build;
  return [
    { ...lib, output: lib.output.filter((o) => o !== false && outputPath(o) === "lib") },
    await browserBuild(rollup, compiled),
  ];
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
  const tsc = join(pixi, "node_modules/typescript/bin/tsc");
  await run(process.execPath, [tsc, "-p", declarationConfig()]);
  copyDeclarations("");
  await run(process.execPath, ["scripts/types/fixTypes.mts"]);
}

function fail(message: string): never {
  console.error(`pixi.js: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!existsSync(join(pixi, "package.json"))) {
    fail("vendor/pixijs is empty: run git submodule update --init, then pnpm install");
  }

  if (!existsSync(join(pixi, "node_modules/rollup"))) {
    fail("vendor/pixijs has no build tools: run pnpm install");
  }

  // The stamp is the key, then the files written to dist/: the chunks too,
  // which a page without WebGL would fail to load if one were gone.
  const key = sourceKey();
  const [stampKey, ...written] = existsSync(stampFile)
    ? readFileSync(stampFile, "utf8").split("\n")
    : [];
  const built =
    stampKey === key &&
    BUNDLES.every((path) => written.includes(path)) &&
    written.every((path) => existsSync(join(pixi, path)));
  if (built && !process.argv.includes("--force")) {
    console.log("pixi.js: up to date");
    return;
  }

  rmSync(join(pixi, "lib"), { recursive: true, force: true });
  rmSync(join(pixi, "dist"), { recursive: true, force: true });

  const compiled = new Date(git("log", "-1", "--format=%cI").trim()).toUTCString();
  const rollupUrl = pathToFileURL(join(pixi, "node_modules/rollup/dist/es/rollup.js")).href;
  const rollup: Rollup = await import(rollupUrl);
  const builds = await rollupBuilds(rollup, compiled.replace("GMT", "UTC"));
  await Promise.all([declarations(), ...builds.map((build) => bundle(rollup, build))]);

  const dist = readdirSync(join(pixi, "dist"), { recursive: true, encoding: "utf8" })
    .map((path) => join("dist", path))
    .filter((path) => !path.endsWith(".map") && statSync(join(pixi, path)).isFile())
    .sort();
  writeFileSync(stampFile, [key, ...dist].join("\n"));
  console.log(`pixi.js: built lib/ and ${BUNDLES.join(", ")}`);
}

if (import.meta.main) {
  await main();
}
