import type { Container } from "../../../packages/player/dist/display/display.js";
import type { MorphPresentation } from "./scene.ts";

export function presentedMorph(stage: Container, p: MorphPresentation): void {
  if (p.object.morph !== p.morph || !stage.encloses(p.object)) {
    return;
  }

  // Rendering may lag the VM; acknowledge the captured pose without changing its current ratio.
  const ratio = p.object.ratio;
  try {
    p.object.ratio = p.ratio;
    p.object.drawn();
  } finally {
    p.object.ratio = ratio;
  }
}
