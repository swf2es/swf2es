// The packages as npm would get them: each packed by pnpm, as `pnpm
// publish` packs it, and its tarball checked (the licence and notices, a
// README, what package.json says, the files its exports name, no build
// state); then all of them installed with npm into an empty project outside
// the repository, offline, as they need nothing but each other. There every
// export path imports, every source map finds its sources, and the
// installed swf2es command compiles an AS3 SWF and runs an ABC with no
// --lib, on the libraries it ships. Run after `pnpm build`; it builds nothing.
//
//   node tests/packages/run.ts
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PUBLIC_PACKAGES, spdx } from "../../tools/notices.ts";
import * as w from "../swf-writer.ts";
import { abc, tables, u30 } from "../unit/codegen/abc-builder.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
// Outside the repository, so that nothing resolves through its node_modules.
const work = mkdtempSync(join(tmpdir(), "swf2es-packages-"));
const tarballs = join(work, "tarballs");
const project = join(work, "project");
after(() => rmSync(work, { recursive: true, force: true }));

/** What importing them in node cannot show: a binary, and a module that refuses outside a worker. */
const NOT_IMPORTED = new Set(["@swf2es/codegen/codegen.wasm", "@swf2es/player-hosts/node-worker"]);

interface Packed {
  name: string;
  tarball: string;
  files: Set<string>;
  pkg: {
    name: string;
    version: string;
    license?: string;
    repository?: { directory?: string };
    exports: Record<string, string | Record<string, string>>;
    bin?: Record<string, string>;
    [field: string]: unknown;
  };
}

for (const name of PUBLIC_PACKAGES) {
  if (!existsSync(join(root, `packages/${name}/dist`))) {
    throw new Error(`packages/${name} is not built: run pnpm build first`);
  }
}

mkdirSync(tarballs, { recursive: true });
const packed: Packed[] = await Promise.all(
  PUBLIC_PACKAGES.map(async (name) => {
    const dir = join(root, `packages/${name}`);
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    await run("pnpm", ["pack", "--pack-destination", tarballs], { cwd: dir });
    const tarball = join(tarballs, `swf2es-${name}-${version}.tgz`);
    const listing = (await run("tar", ["-tzf", tarball], { maxBuffer: 64 << 20 })).stdout;
    const files = new Set(listing.split("\n").filter(Boolean));
    const pkg = JSON.parse(
      (await run("tar", ["-xzOf", tarball, "package/package.json"])).stdout,
    ) as Packed["pkg"];
    return { name, tarball, files, pkg };
  }),
);

// Strings 1 trace, 2 "", 3 hello. Namespace 1 public. Multiname 1 trace.
// findpropstrict trace, pushstring "hello", callpropvoid trace 1, returnvoid.
const hello = abc(
  {
    strings: ["trace", "", "hello"],
    namespaces: [[0x16, ...u30(2)]],
    multinames: [[0x07, ...u30(1), ...u30(1)]],
  },
  tables({
    methods: [{}],
    scripts: [{ init: 0 }],
    bodies: [
      {
        method: 0,
        code: [0xd0, 0x30, 0x5d, 1, 0x2c, 3, 0x4f, 1, 1, 0x47],
        maxStack: 2,
        maxScopeDepth: 2,
      },
    ],
  }),
);
const helloSwf = w.swf({
  width: 100,
  height: 100,
  frameCount: 1,
  tags: [w.fileAttributes(true), w.doAbc(hello, "hello"), w.showFrame(), w.end()],
});

mkdirSync(project, { recursive: true });
writeFileSync(
  join(project, "package.json"),
  `${JSON.stringify({ name: "swf2es-packages-check", private: true, type: "module" })}\n`,
);
writeFileSync(join(project, "hello.abc"), hello);
writeFileSync(join(project, "hello.swf"), helloSwf);
const install = spawnSync(
  "npm",
  [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    ...packed.map((p) => p.tarball),
  ],
  { cwd: project, encoding: "utf8" },
);
if (install.status !== 0) {
  throw new Error(`npm install failed:\n${install.stdout}${install.stderr}`);
}

const installed = (name: string) => join(project, "node_modules/@swf2es", name);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The files an exports map names. */
function exportTargets(exports: Packed["pkg"]["exports"]): string[] {
  return Object.values(exports).flatMap((target) =>
    typeof target === "string" ? [target] : Object.values(target),
  );
}

for (const p of packed) {
  test(`@swf2es/${p.name}'s tarball has its licence, notices and README, and no build state`, () => {
    assert.ok(p.files.has("package/README.md"));
    assert.equal(
      readFileSync(join(installed(p.name), "LICENSE"), "utf8"),
      readFileSync(join(root, "LICENSE"), "utf8"),
    );
    const notices = join(root, `packages/${p.name}/LICENSE.third-party`);
    assert.equal(p.files.has("package/LICENSE.third-party"), existsSync(notices));
    if (existsSync(notices)) {
      assert.equal(
        readFileSync(join(installed(p.name), "LICENSE.third-party"), "utf8"),
        readFileSync(notices, "utf8"),
      );
    }

    const unwanted = [...p.files].filter((f) => /\.tsbuildinfo$|\.test\.ts$|\/out\//.test(f));
    assert.deepEqual(unwanted, []);
  });

  test(`@swf2es/${p.name}'s package.json is what npm is to publish`, () => {
    assert.equal(p.pkg.license, spdx(p.name));
    assert.equal(p.pkg.repository?.directory, `packages/${p.name}`);
    assert.ok(!p.pkg.private);
    // pnpm pack gives workspace:* the version.
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = (p.pkg[field] ?? {}) as Record<string, string>;
      for (const [dep, range] of Object.entries(deps)) {
        assert.doesNotMatch(range, /workspace:/, `${dep}: ${range}`);
      }
    }

    const missing = [...exportTargets(p.pkg.exports), ...Object.values(p.pkg.bin ?? {})]
      .map((target) => `package/${target.replace(/^\.\//, "")}`)
      .filter((file) => !p.files.has(file));
    assert.deepEqual(missing, []);
  });
}

test("every export path of every package imports in node, from the installed packages", () => {
  const specifiers = packed
    .flatMap((p) => Object.keys(p.pkg.exports).map((key) => `${p.pkg.name}${key.slice(1)}`))
    .filter((s) => !NOT_IMPORTED.has(s));
  // From the project, as its own code would import them.
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const failures = [];
for (const specifier of JSON.parse(process.argv[1])) {
  try {
    if (!import.meta.resolve(specifier).startsWith(${JSON.stringify(pathToFileURL(project).href)})) {
      throw new Error("resolved outside the project");
    }
    await import(specifier);
  } catch (e) {
    failures.push(specifier + ": " + e.message);
  }
}
console.log(JSON.stringify(failures));`,
      JSON.stringify(specifiers),
    ],
    { cwd: project, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "[]"), []);
  assert.ok(specifiers.length > 20, `${specifiers.length} export paths`);
});

test("every source map of the installed packages finds its sources", () => {
  const missing: string[] = [];
  let maps = 0;
  for (const p of packed) {
    const dir = installed(p.name);
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".map")) {
        continue;
      }

      maps++;
      const map = JSON.parse(readFileSync(join(dir, file), "utf8"));
      for (const source of map.sources as string[]) {
        const path = resolve(dirname(join(dir, file)), map.sourceRoot ?? "", source);
        // native leaves out its binaries' base64, which dist holds again.
        if (!existsSync(path) && !(p.name === "native" && path.endsWith("/binary.ts"))) {
          missing.push(`@swf2es/${p.name}/${file}: ${source}`);
        }
      }
    }
  }

  assert.deepEqual(missing.slice(0, 10), []);
  assert.ok(maps > 0);
});

const swf2es = (...args: string[]) =>
  spawnSync(join(project, "node_modules/.bin/swf2es"), args, { cwd: project, encoding: "utf8" });

test("the installed swf2es compiles an AS3 SWF with the libraries it ships", () => {
  const r = swf2es("compile", "hello.swf", "-o", "hello.swf2es", "--emit-libraries");
  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(join(project, "hello.swf2es/manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.libraries.map((l: { name: string }) => l.name),
    ["builtin", "playerglobal-swf2es"],
  );
  const builtin = join(root, "oracle/avmplus/generated/builtin.abc");
  if (existsSync(builtin)) {
    assert.equal(manifest.libraries[0].sha256, sha256(readFileSync(builtin)));
  }

  assert.equal(manifest.abcs.length, 1);
  for (const entry of [...manifest.libraries, ...manifest.abcs]) {
    assert.ok(existsSync(join(project, "hello.swf2es", entry.module)), entry.module);
  }

  const air = swf2es("hello.swf", "-o", "hello-air.swf2es", "--air", "-q");
  assert.equal(air.status, 0, air.stderr);
  const airManifest = JSON.parse(
    readFileSync(join(project, "hello-air.swf2es/manifest.json"), "utf8"),
  );
  assert.deepEqual(
    airManifest.libraries.map((l: { name: string }) => l.name),
    ["builtin", "playerglobal-swf2es", "air"],
  );
});

test("the installed swf2es runs an ABC on avmshell's libraries, which it ships", () => {
  const r = swf2es("run", "hello.abc");
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "hello\n", ""]);
});
