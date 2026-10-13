// pnpm reads only a CommonJS pnpmfile, hence .cjs.
//
// vendor/pixijs, the swf2es fork of PixiJS, is a workspace package, and pnpm
// would install all its devDependencies: jest, eslint, typedoc and the rest,
// about a thousand packages swf2es never runs. tools/pixijs.ts needs only
// the tools that build lib/ and dist/, so the fork's manifest keeps those,
// at the exact versions of its own package-lock.json like its dependencies,
// so that the build matches what upstream's lockfile builds. jest, which a
// build plugin names as a peer, is left out too. Its `prepare`
// script (husky) goes too: an install must not set the fork's git hooks.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const PIXI_BUILD_TOOLS = [
  "@pixi/webworker-plugins",
  "@rollup/plugin-alias",
  "@rollup/plugin-commonjs",
  "@rollup/plugin-json",
  "@rollup/plugin-node-resolve",
  "esbuild",
  "glob",
  "rollup",
  "rollup-plugin-esbuild",
  "rollup-plugin-external-globals",
  "rollup-plugin-jscc",
  "rollup-plugin-sourcemaps",
  "rollup-plugin-string",
  "typescript",
];

let locked;

function lockedVersion(name) {
  locked ??= JSON.parse(
    readFileSync(join(__dirname, "vendor/pixijs/package-lock.json"), "utf8"),
  ).packages;
  const version = locked[`node_modules/${name}`]?.version;
  if (version === undefined) {
    throw new Error(`vendor/pixijs/package-lock.json locks no ${name}`);
  }

  return version;
}

function pin(names) {
  return Object.fromEntries(names.map((name) => [name, lockedVersion(name)]));
}

// Its rollup plugin's jest transform is the fork's test setup, not its build.
const JEST_PEERS = ["@jest/transform", "jest", "ts-jest"];

function readPackage(manifest, context) {
  if (manifest.name === "@pixi/webworker-plugins") {
    for (const name of JEST_PEERS) {
      delete manifest.peerDependencies?.[name];
    }

    return manifest;
  }

  if (manifest.name !== "pixi.js" || manifest.devDependencies === undefined) {
    return manifest;
  }

  context.log("pixi.js: only its build tools, at its lockfile's versions");
  manifest.dependencies = pin(Object.keys(manifest.dependencies ?? {}));
  manifest.devDependencies = pin(PIXI_BUILD_TOOLS);
  delete manifest.scripts?.prepare;
  return manifest;
}

module.exports = { hooks: { readPackage } };
