// Publishes the packages to npm (docs/releasing.md): each packed by pnpm,
// which turns its `workspace:*` ranges into the version, then the tarballs
// published with npm in the order their dependencies need, so that no
// package is ever on npm before one it depends on. A package whose version
// is on npm already is passed by, so a release that stopped half way runs
// again. Run after `pnpm build`.
//
//   node tools/publish.ts [--dry-run] [--provenance] [--tag <dist-tag>]
//
// --provenance asks npm to attest where the package was built, which only
// a CI's identity can (release.yml); --tag names the dist-tag, `latest` by
// default, `next` for a prerelease. RELEASE_TAG, set by release.yml to the
// git tag that started it, must be `v` and the packages' version.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PUBLISHED } from "./notices.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    provenance: { type: "boolean", default: false },
    tag: { type: "string" },
  },
});

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifests = new Map<string, Manifest>(
  PUBLISHED.map((dir) => [
    dir,
    JSON.parse(readFileSync(join(root, `${dir}/package.json`), "utf8")) as Manifest,
  ]),
);

// One version for them all, and the git tag's where a tag started the release.
const versions = new Set([...manifests.values()].map((m) => m.version));
if (versions.size !== 1) {
  throw new Error(`the packages' versions differ: ${[...versions].join(", ")} (tools/version.ts)`);
}

const [version] = versions;
const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${version}`) {
  throw new Error(`the git tag ${tag} is not v${version}, the packages' version`);
}

const distTag = values.tag ?? (version.includes("-") ? "next" : "latest");

/** The packages in an order where each comes after the published ones it depends on, even at build time. */
function ordered(): string[] {
  const byName = new Map([...manifests].map(([dir, m]) => [m.name, dir]));
  const done: string[] = [];
  const visiting = new Set<string>();
  const visit = (dir: string) => {
    if (done.includes(dir)) {
      return;
    }

    if (visiting.has(dir)) {
      throw new Error(`the packages depend on one another in a cycle, through ${dir}`);
    }

    visiting.add(dir);
    const m = manifests.get(dir) as Manifest;
    for (const name of Object.keys({ ...m.dependencies, ...m.devDependencies })) {
      const other = byName.get(name);
      if (other) {
        visit(other);
      }
    }

    visiting.delete(dir);
    done.push(dir);
  };
  for (const dir of PUBLISHED) {
    visit(dir);
  }

  return done;
}

/** Whether `name` is on npm at `version` already. */
function published(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === version;
}

const work = mkdtempSync(join(tmpdir(), "swf2es-publish-"));
try {
  console.log(
    `swf2es ${version} to npm as ${distTag}${values["dry-run"] ? ", a dry run" : ""}${values.provenance ? ", with provenance" : ""}`,
  );
  for (const dir of ordered()) {
    const { name } = manifests.get(dir) as Manifest;
    if (!existsSync(join(root, `${dir}/dist`))) {
      throw new Error(`${dir} is not built: run pnpm build first`);
    }

    if (published(name, version)) {
      console.log(`${name}@${version}: on npm already`);
      continue;
    }

    const out = join(work, dir.replace("/", "-"));
    execFileSync("pnpm", ["pack", "--pack-destination", out], {
      cwd: join(root, dir),
      stdio: "ignore",
    });
    const [tarball] = readdirSync(out).filter((f) => f.endsWith(".tgz"));
    execFileSync(
      "npm",
      [
        "publish",
        join(out, tarball),
        "--access",
        "public",
        "--tag",
        distTag,
        ...(values.provenance ? ["--provenance"] : []),
        ...(values["dry-run"] ? ["--dry-run"] : []),
      ],
      { stdio: "inherit" },
    );
    console.log(`${name}@${version}: ${values["dry-run"] ? "would be published" : "published"}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
