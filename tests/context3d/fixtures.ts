import { readFileSync } from "node:fs";
import { oldHeader } from "./atf/old-header.ts";

/** AIR fixes back-buffer depth in the application descriptor, so test both in separate runs. */
export function fixtureSource(name: string): string {
  if (name === "FrameValidationFlat") {
    return fixtureSource("FrameValidation")
      .replaceAll("FrameValidation", name)
      .replaceAll("framevalidation", name.toLowerCase())
      .replace("const backDepth:Boolean = true", "const backDepth:Boolean = false");
  }

  // As old content gets it, for its size errors; and in baselineConstrained, where AIR draws no
  // back buffer larger than the stage and swf2es does.
  if (name === "BackBufferLegacy" || name === "BackBufferConstrained") {
    const source = fixtureSource("BackBuffer")
      .replaceAll(/\bBackBuffer\b/g, name)
      .replaceAll('"backbuffer', `"${name.toLowerCase()}`);
    if (name === "BackBufferConstrained") {
      return source.replace(
        'profiles:Array = ["baseline"]',
        'profiles:Array = ["baselineConstrained"]',
      );
    }

    // Without what SWFs before 26 cannot see (backBufferWidth, maxBackBufferWidth, profile),
    // which swf2es still shows them. A probe's call ends at its function's `});`, on its
    // line or, as asformat writes it, lines below.
    return source
      .replace(/return read\("backBufferWidth"\)[^;]*;/, 'return "-";')
      .replace('read("profile")', '"-"')
      .replace(/^[ \t]*probe\("(disposed-)?most-[\s\S]*?\}\);\n/gm, "");
  }

  // AtfTextures' textures, inlined as base64 for ASC, which embeds no files.
  return readFileSync(new URL(`${name}.as`, import.meta.url), "utf8").replace(
    /atf\("(ATF|OLD)_([a-z0-9-]+)"\)/g,
    (_, header: string, file: string) => {
      const atf = new Uint8Array(readFileSync(new URL(`atf/${file}.atf`, import.meta.url)));
      return `atf("${Buffer.from(header === "OLD" ? oldHeader(atf) : atf).toString("base64")}")`;
    },
  );
}
