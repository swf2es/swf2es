// The licence files each published package carries, as npm ships only what
// is in a package's own folder: LICENSE, the repository's Apache License
// 2.0, and LICENSE.third-party, the notices of the code from elsewhere that
// the package holds, with the SPDX expression of the whole for its
// package.json. @swf2es/native's LICENSE.third-party is its build's
// (packages/native/build.ts), which compiles the C it covers.
//
//   node tools/notices.ts [--update]
//
// fails if a package's files or `license` are not these; --update writes them.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** The packages published to npm; apps/ are not. */
export const PUBLIC_PACKAGES = [
  "cli",
  "codegen",
  "context3d",
  "format",
  "native",
  "player",
  "player-hosts",
  "render",
  "runtime",
  "swf2es",
  "web",
];

/**
 * The packages whose modules player-hosts copies into dist/thread/ for its
 * Web Workers (build-thread.ts): it carries their notices too.
 */
export const THREAD_PACKAGES = ["codegen", "format", "native", "player", "runtime"];

/** The packages the browser build, swf2es, bundles (its build.ts): it carries their notices too. */
export const BUNDLED_PACKAGES = [
  "codegen",
  "context3d",
  "format",
  "native",
  "player",
  "player-hosts",
  "render",
  "runtime",
  "web",
];

/** Code from elsewhere, by what its files' headers say, or what bundled it. */
export type Origin = "avmplus" | "ruffle" | "w3c" | "assemblyscript" | "native" | "rspack";

interface Notice {
  title: string;
  /** SPDX terms this adds to the package's expression. */
  spdx: string[];
  text: string;
}

/** The commit of avmplus the embedded ABCs were generated from, as their modules name it. */
function avmplusCommit(): string {
  const header = read("packages/runtime/src/avm2/builtin-library.ts").match(
    /\n\/\/ ([0-9a-f]{40}),/,
  );
  if (!header) {
    throw new Error("builtin-library.ts names no avmplus commit");
  }

  return header[1];
}

const RUFFLE_MIT = `The MIT License (MIT)

Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** `what` came from Ruffle: its terms. */
function ruffle(what: string): Notice {
  return {
    title: "Ruffle",
    spdx: ["(Apache-2.0 OR MIT)"],
    text: `${what}

Ruffle, https://github.com/ruffle-rs/ruffle, is under the MIT license or
the Apache License 2.0 (LICENSE), at your choice. Its MIT terms:

${RUFFLE_MIT}`,
  };
}

/** `what` is avmplus', under the MPL, its source form where `source` says: the MPL's text. */
function avmplus(what: string, source: string): Notice {
  return {
    title: "avmplus",
    spdx: ["MPL-2.0"],
    text: `${what}

These are subject to the Mozilla Public License, v. 2.0, below.
${source}
Each ABC is compiled from avmplus' ActionScript, whose source form is at
https://github.com/swf2es/avmplus/tree/${avmplusCommit()}.

${read("oracle/avmplus/LICENSE")}`,
  };
}

/** `what` derives from SVG 1.1's feTurbulence: W3C's notice. */
function w3c(what: string): Notice {
  return {
    title: "SVG's feTurbulence",
    spdx: ["W3C-20150513"],
    text: `${what}

Copyright © 2015 W3C® (MIT, ERCIM, Keio, Beihang). This software or
document includes material copied from or derived from SVG 1.1, under the
W3C Software and Document License:
https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document
`,
  };
}

function assemblyScript(): Notice {
  return {
    title: "AssemblyScript",
    // Its NOTICE names parts of its standard library from musl and Arm (MIT) and V8 (BSD-3-Clause).
    spdx: ["MIT", "BSD-3-Clause"],
    text: `dist/codegen.wasm is compiled by AssemblyScript,
https://github.com/AssemblyScript/assemblyscript, and holds its runtime
and the parts of its standard library the compiler uses, under the Apache
License 2.0 (LICENSE). swf2es changes one of them, its Grisu2 number
formatting (std/assembly/util/number.ts), so that it reads no further than
its table of powers of ten: the repository's
patches/assemblyscript@0.28.20.patch. Its NOTICE:

${read("packages/codegen/node_modules/assemblyscript/NOTICE")}`,
  };
}

/** @swf2es/native's own notices, its build's, for a package that holds its modules. */
function native(what: string): Notice {
  const spdx = JSON.parse(read("packages/native/package.json")).license as string;
  return {
    title: "@swf2es/native",
    spdx: spdx.split(" AND ").filter((term) => term !== "Apache-2.0"),
    text: `${what} Its LICENSE.third-party:

${read("packages/native/LICENSE.third-party")}`,
  };
}

/** The runtime Rspack writes into a bundle. */
function rspack(): Notice {
  return {
    title: "Rspack",
    spdx: ["MIT"],
    text: `dist/swf2es.js, dist/worker.js and dist/chunks/ are bundled by Rspack,
https://github.com/web-infra-dev/rspack, and hold the runtime it writes
into a bundle, under the MIT License:

${read("packages/swf2es/node_modules/@rspack/core/LICENSE")}`,
  };
}

/** What each package holds from elsewhere, besides its own Apache-2.0 code. */
function notices(name: string): Notice[] {
  switch (name) {
    case "cli":
      return [
        avmplus(
          `src/shell-toplevel-library.ts, and dist/shell-toplevel-library.js
compiled from it, hold avmplus' shell_toplevel.abc, which \`swf2es run\`
loads after builtin.abc, as avmshell does.`,
          "Its TypeScript is under src/.",
        ),
      ];
    case "codegen":
      return [
        ruffle(`Where Flash's readings of malformed AVM1 actions are not documented,
dist/codegen.wasm's decoder follows Ruffle's: swf/src/avm1/read.rs and
core/src/avm1/activation.rs, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
contributors.`),
        assemblyScript(),
      ];
    case "format":
      return [
        ruffle(`Parts of the files under src/, and of dist/ compiled from them, are taken
or ported from Ruffle, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
contributors: each file's header says so.`),
      ];
    case "player":
      return [
        ruffle(`Parts of the files under src/, and of dist/ compiled from them, are taken
or ported from Ruffle, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
contributors: each file's header says so. playerglobal's ABC
(src/playerglobal/playerglobal-library.ts) is compiled from ActionScript
much of which is Ruffle's, as the repository's as3/playerglobal/ has it.`),
        w3c(`src/bitmap/turbulence.ts, and dist/bitmap/turbulence.js compiled from it,
derive from the reference implementation of feTurbulence in Scalable Vector
Graphics (SVG) 1.1 (Second Edition),
https://www.w3.org/TR/SVG11/filters.html#feTurbulenceElement`),
      ];
    case "player-hosts":
      return [
        ruffle(`dist/thread/ holds the modules of @swf2es/codegen, @swf2es/format,
@swf2es/player and @swf2es/runtime for the Web Workers. Parts of them are
taken or ported from Ruffle, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
contributors, as each file's header says, and playerglobal's ABC
(player/playerglobal/playerglobal-library.js) is compiled from ActionScript
much of which is Ruffle's.`),
        avmplus(
          `dist/thread/runtime/ holds @swf2es/runtime's modules: avmplus'
builtin.abc (avm2/builtin-library.js), and the files whose headers say they
are translated from avmplus.`,
          `Their TypeScript is @swf2es/runtime's src/,
and the repository's packages/runtime/src/.`,
        ),
        w3c(`dist/thread/player/bitmap/turbulence.js derives from the reference
implementation of feTurbulence in Scalable Vector Graphics (SVG) 1.1
(Second Edition), https://www.w3.org/TR/SVG11/filters.html#feTurbulenceElement`),
        native("dist/thread/native/ holds @swf2es/native's modules, with their WebAssembly."),
      ];
    case "runtime":
      return [
        avmplus(
          `src/avm2/builtin-library.ts holds avmplus' builtin.abc, and the files
under src/ whose headers say so are translated from avmplus; dist/ holds
them compiled.`,
          "Their TypeScript is under src/.",
        ),
        ruffle(`Parts of the files under src/, and of dist/ compiled from them, are taken
or ported from Ruffle, Copyright (c) 2018-2022 Ruffle LLC and Ruffle
contributors: each file's header says so.`),
      ];
    case "swf2es":
      return [
        ruffle(`dist/swf2es.js, dist/worker.js and dist/chunks/ bundle the modules of
swf2es's packages, @swf2es/codegen, @swf2es/format, @swf2es/player and
@swf2es/runtime among them. Parts of them are taken or ported from Ruffle,
Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors, as each file's
header in those packages says, and playerglobal's ABC is compiled from
ActionScript much of which is Ruffle's. Where Flash's readings of
malformed AVM1 actions are not documented, dist/codegen.wasm's decoder
follows Ruffle's: swf/src/avm1/read.rs and core/src/avm1/activation.rs.`),
        avmplus(
          `The bundle holds @swf2es/runtime's modules: avmplus' builtin.abc, and the
files whose headers say they are translated from avmplus.`,
          `Their TypeScript is @swf2es/runtime's src/, and
the repository's packages/runtime/src/; the bundle's source maps hold the
modules they were bundled from.`,
        ),
        w3c(`The bundle holds @swf2es/player's bitmap/turbulence.js, which derives
from the reference implementation of feTurbulence in Scalable Vector
Graphics (SVG) 1.1 (Second Edition),
https://www.w3.org/TR/SVG11/filters.html#feTurbulenceElement`),
        assemblyScript(),
        native("The bundle holds @swf2es/native's modules, with their WebAssembly."),
        rspack(),
      ];
    default:
      return [];
  }
}

/** What each package holds from elsewhere, by origin, for a test to hold against their headers. */
export function origins(name: string): Origin[] {
  const titles: Record<string, Origin> = {
    avmplus: "avmplus",
    Ruffle: "ruffle",
    "SVG's feTurbulence": "w3c",
    AssemblyScript: "assemblyscript",
    "@swf2es/native": "native",
    Rspack: "rspack",
  };
  return notices(name).map((n) => titles[n.title]);
}

/** The package's `license`: Apache-2.0 and what its notices add, native's its build's. */
export function spdx(name: string): string {
  if (name === "native") {
    return `${JSON.parse(read("packages/native/package.json")).license}`;
  }

  const terms = ["Apache-2.0"];
  for (const term of notices(name).flatMap((n) => n.spdx)) {
    if (!terms.includes(term)) {
      terms.push(term);
    }
  }

  return terms.join(" AND ");
}

/** The package's LICENSE.third-party, or null for one with none of its own to write. */
function thirdParty(name: string): string | null {
  const list = notices(name);
  if (list.length === 0 || name === "native") {
    return null;
  }

  const sections = list.map((n) => `${n.title}\n${"=".repeat(n.title.length)}\n\n${n.text}`);
  const pkg = name === "swf2es" ? name : `@swf2es/${name}`;
  return `Code from elsewhere in ${pkg}, and its terms. The package's own
code is under the Apache License 2.0 (LICENSE).


${sections.join("\n\n")}`;
}

/** Each file tools/notices.ts writes or checks, by its path in the repository, and its contents. */
export function expected(): Map<string, string> {
  const files = new Map<string, string>();
  const license = read("LICENSE");
  for (const name of PUBLIC_PACKAGES) {
    files.set(`packages/${name}/LICENSE`, license);
    const text = thirdParty(name);
    if (text !== null) {
      files.set(`packages/${name}/LICENSE.third-party`, text);
    }
  }

  return files;
}

if (import.meta.main) {
  const update = process.argv.includes("--update");
  let stale = 0;
  for (const [path, text] of expected()) {
    const full = join(root, path);
    if (update) {
      writeFileSync(full, text);
    } else if (!existsSync(full) || readFileSync(full, "utf8") !== text) {
      console.error(`${path} is not what tools/notices.ts writes`);
      stale++;
    }
  }

  for (const name of PUBLIC_PACKAGES) {
    const path = join(root, `packages/${name}/package.json`);
    const text = readFileSync(path, "utf8");
    const pkg = JSON.parse(text);
    if (pkg.license === spdx(name)) {
      continue;
    }

    if (update) {
      writeFileSync(path, text.replace(/"license": "[^"]*"/, `"license": "${spdx(name)}"`));
    } else {
      console.error(`packages/${name}/package.json's license is not ${spdx(name)}`);
      stale++;
    }
  }

  if (stale > 0) {
    console.error("run node tools/notices.ts --update");
    process.exit(1);
  }
}
