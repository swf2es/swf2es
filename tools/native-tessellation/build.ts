import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { findZig, ZIG_VERSION } from "../zig.ts";

const UPSTREAM = "8dbd6483e920311a58c9af10a10beb278efebc36";
const self = fileURLToPath(new URL(".", import.meta.url));
const symbols = [
  "reset",
  "alloc",
  "run",
  "vertices",
  "indices",
  "vertexCount",
  "triangleCount",
  "highWater",
  "allocated",
  "setLimit",
];

/** Standalone artifacts go outside the checkout; no production dependency is installed. */
export function build(out: string): void {
  mkdirSync(out, { recursive: true });
  const upstream = resolve(out, "libtess2");
  if (!existsSync(upstream)) {
    execFileSync("git", ["clone", "https://github.com/memononen/libtess2.git", upstream]);
  }

  execFileSync("git", ["-C", upstream, "checkout", "--detach", UPSTREAM]);
  const include = resolve(out, "include");
  mkdirSync(include, { recursive: true });
  const headers: Record<string, string> = {
    "setjmp.h":
      "typedef int jmp_buf[1];\n#define setjmp(x) 0\n__attribute__((noreturn)) void longjmp(int*,int);\n",
    "stdlib.h":
      "#include <stddef.h>\nvoid *malloc(size_t); void *realloc(void*,size_t); void free(void*);\n",
    "stdio.h": "int printf(const char*,...);\n",
    "assert.h": "#define assert(x) ((void)0)\n",
    "math.h":
      "#define sqrtf(x) __builtin_sqrtf(x)\n#define sqrt(x) __builtin_sqrt(x)\n#define fabs(x) __builtin_fabs(x)\n#define isnan(x) __builtin_isnan(x)\n",
  };
  for (const [name, text] of Object.entries(headers)) {
    writeFileSync(resolve(include, name), text);
  }

  cpSync(resolve(upstream, "LICENSE.txt"), resolve(out, "LICENSE.libtess2.txt"));
  const sizes = [];
  for (const variant of ["f32", "f64"]) {
    const dir = resolve(out, `source-${variant}`);
    mkdirSync(dir, { recursive: true });
    for (const part of ["Source", "Include"]) {
      cpSync(resolve(upstream, part), resolve(dir, part), { recursive: true });
    }

    if (variant === "f64") {
      const header = resolve(dir, "Include/tesselator.h");
      writeFileSync(
        header,
        readFileSync(header, "utf8").replace("typedef float TESSreal;", "typedef double TESSreal;"),
      );
      const source = resolve(dir, "Source/tess.c");
      writeFileSync(source, readFileSync(source, "utf8").replace("sqrtf( len )", "sqrt( len )"));
    }

    const sources = ["bucketalloc", "dict", "geom", "mesh", "priorityq", "sweep", "tess"].map(
      (name) => resolve(dir, `Source/${name}.c`),
    );
    const output = resolve(out, `${variant}.wasm`);
    execFileSync(
      findZig(),
      [
        "cc",
        "-target",
        "wasm32-freestanding",
        "-O2",
        "-DNDEBUG",
        "-nostdlib",
        "-mbulk-memory",
        `-I${include}`,
        `-I${dir}/Include`,
        "-Wl,--no-entry",
        "-Wl,-z,stack-size=262144",
        "-Wl,--export-memory",
        "-Wl,--strip-all",
        ...symbols.map((name) => `-Wl,--export=${name}`),
        resolve(self, "wrapper.c"),
        ...sources,
        "-o",
        output,
      ],
      { stdio: "inherit" },
    );
    const bytes = readFileSync(output);
    sizes.push({
      variant,
      bytes: bytes.length,
      gzip: gzipSync(bytes).length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const report = { upstream: UPSTREAM, zig: ZIG_VERSION, sizes };
  writeFileSync(resolve(out, "build.json"), JSON.stringify(report, null, 2));
  console.log(report);
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    throw new Error("usage: node tools/native-tessellation/build.ts <external-output-directory>");
  }

  build(resolve(out));
}
