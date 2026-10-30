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

  // AtfTextures' textures, inlined as base64 for ASC, which embeds no files.
  return readFileSync(new URL(`${name}.as`, import.meta.url), "utf8").replace(
    /atf\("(ATF|OLD)_([a-z0-9-]+)"\)/g,
    (_, header: string, file: string) => {
      const atf = new Uint8Array(readFileSync(new URL(`atf/${file}.atf`, import.meta.url)));
      return `atf("${Buffer.from(header === "OLD" ? oldHeader(atf) : atf).toString("base64")}")`;
    },
  );
}
