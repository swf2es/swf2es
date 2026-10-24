import { readFileSync } from "node:fs";

/** AIR fixes back-buffer depth in the application descriptor, so test both in separate runs. */
export function fixtureSource(name: string): string {
  if (name === "FrameValidationFlat") {
    return fixtureSource("FrameValidation")
      .replaceAll("FrameValidation", name)
      .replaceAll("framevalidation", name.toLowerCase())
      .replace("const backDepth:Boolean = true", "const backDepth:Boolean = false");
  }

  return readFileSync(new URL(`${name}.as`, import.meta.url), "utf8");
}
