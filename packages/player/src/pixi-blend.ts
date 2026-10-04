// Blend modes as Flash composites them (docs/architecture.md, "Blend
// modes"): the object drawn as a layer, its children together, then that
// layer blended with what is below by the mode's formula, which a filter
// that reads the back buffer computes. Colours are premultiplied.
import {
  AlphaFilter,
  BlendModeFilter,
  type Bounds,
  type Filter,
  FilterEffect,
  FilterSystem,
  RenderTargetSystem,
} from "pixi.js";

const filterSystem = FilterSystem.prototype as unknown as {
  _calculateFilterArea(instruction: { filterEffect: FilterEffect }, bounds: Bounds): void;
};

// A layer's region holds what its filtered children draw past their shapes,
// as Flash's layer holds a child's glow whole: Pixi measures a filtered
// object by its descendants' shapes alone, and cut a blurred child of a
// blend off at its shapes' edges. Each filter of a descendant grows the
// region by its padding, in the stage's pixels as Pixi pads; the object's
// own filters are padded by Pixi after.
let measuring: FilterEffect | null = null;
(FilterEffect.prototype as FilterEffect & { addBounds(bounds: Bounds): void }).addBounds =
  function (this: FilterEffect, bounds: Bounds) {
    if (this === measuring || !this.filters) {
      return;
    }

    let padding = 0;
    for (const f of this.filters) {
      if (f.enabled) {
        padding += f.padding;
      }
    }

    bounds.pad(padding | 0);
  };
const calculateFilterArea = filterSystem._calculateFilterArea;
filterSystem._calculateFilterArea = function (instruction, bounds) {
  measuring = instruction.filterEffect;
  try {
    calculateFilterArea.call(this, instruction, bounds);
  } finally {
    measuring = null;
  }
};

// The copy of what is behind a blend into its back texture, held to both:
// - The texture is sized with a hair of tolerance for rounding, and the
//   copy without, so at some resolutions the copy is a pixel taller or
//   wider than the texture, which GL refuses (copyTexSubImage2D's offset
//   overflow), and the blend reads nothing.
// - An object at or past the target's edge asks for pixels the target does
//   not have; Pixi's own clamp then leaves a width or height below zero,
//   which GL refuses (GL_INVALID_VALUE) and WebGPU fails its frame for.
// What the copy does not reach is not cleared: it lies past what the
// target has, where what the filter draws is cut off anyway (the
// `blend-edges` case matches adl without it). Patched for every renderer
// on the page.
const copyToTexture = RenderTargetSystem.prototype.copyToTexture;
RenderTargetSystem.prototype.copyToTexture = function (source, destination, from, size, to) {
  const target = this.getRenderTarget(source);
  const { pixelWidth, pixelHeight } = destination.source;
  // What the texture can take of what was asked, and of that what the target has.
  const reachX = Math.min(to.x + size.width, pixelWidth);
  const reachY = Math.min(to.y + size.height, pixelHeight);
  const skipX = Math.max(0, -from.x, -to.x);
  const skipY = Math.max(0, -from.y, -to.y);
  const x = from.x + skipX;
  const y = from.y + skipY;
  const toX = to.x + skipX;
  const toY = to.y + skipY;
  const width = Math.min(reachX - toX, target.pixelWidth - x);
  const height = Math.min(reachY - toY, target.pixelHeight - y);
  if (width <= 0 || height <= 0) {
    return destination;
  }

  return copyToTexture.call(
    this,
    source,
    destination,
    { x, y },
    { width, height },
    { x: toX, y: toY },
  );
};

/** Each separable mode's B(back, front) of straight colours, GLSL and WGSL. */
const SEPARABLE: Record<string, [string, string]> = {
  multiply: ["cb * cf", "cb * cf"],
  screen: ["cb + cf - cb * cf", "cb + cf - cb * cf"],
  lighten: ["max(cb, cf)", "max(cb, cf)"],
  darken: ["min(cb, cf)", "min(cb, cf)"],
  difference: ["abs(cb - cf)", "abs(cb - cf)"],
  hardlight: ["hardlight(cb, cf)", "hardlight(cb, cf)"],
  overlay: ["hardlight(cf, cb)", "hardlight(cf, cb)"],
};

const GL_FUNCTIONS = `
  vec3 straight(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }
  vec3 hardlight(vec3 cb, vec3 cf) {
    vec3 multiply = 2.0 * cb * cf;
    vec3 screen = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cf);
    return mix(multiply, screen, step(0.5, cf));
  }
`;

const GPU_FUNCTIONS = `
  fn straight(c: vec4<f32>) -> vec3<f32> { return select(vec3<f32>(0.0), c.rgb / c.a, c.a > 0.0); }
  fn hardlight(cb: vec3<f32>, cf: vec3<f32>) -> vec3<f32> {
    let multiply = 2.0 * cb * cf;
    let screen = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cf);
    return mix(multiply, screen, step(vec3<f32>(0.5), cf));
  }
`;

/** The result of a mode that is no separable blend, premultiplied, GLSL and WGSL. */
const SPECIAL: Record<string, [string, string]> = {
  add: [
    "vec4(min(front.rgb + back.rgb, 1.0), min(front.a + back.a, 1.0))",
    "vec4<f32>(min(front.rgb + back.rgb, vec3<f32>(1.0)), min(front.a + back.a, 1.0))",
  ],
  subtract: [
    "vec4(max(back.rgb - front.rgb, 0.0), back.a)",
    "vec4<f32>(max(back.rgb - front.rgb, vec3<f32>(0.0)), back.a)",
  ],
  // What is below inverted, as far as the object covers it.
  invert: [
    "vec4((back.a - back.rgb) * front.a + back.rgb * (1.0 - front.a), back.a)",
    "vec4<f32>((back.a - back.rgb) * front.a + back.rgb * (1.0 - front.a), back.a)",
  ],
  // The layer below takes the object's alpha where the object has any, or
  // loses it; what the object leaves clear stays, as adl leaves it.
  alpha: ["(front.a > 0.0 ? back * front.a : back)", "select(back, back * front.a, front.a > 0.0)"],
  erase: ["back * (1.0 - front.a)", "back * (1.0 - front.a)"],
};

function blendFilter(mode: string): Filter {
  const special = SPECIAL[mode];
  let gl: string;
  let gpu: string;
  if (special) {
    gl = `finalColor = ${special[0]} * uBlend;`;
    gpu = `out = ${special[1]} * blendUniforms.uBlend;`;
  } else {
    const [glB, gpuB] = SEPARABLE[mode];
    gl = `
      vec3 cb = straight(back);
      vec3 cf = straight(front);
      vec3 co = front.rgb * (1.0 - back.a) + back.rgb * (1.0 - front.a) + front.a * back.a * (${glB});
      finalColor = vec4(co, blendedAlpha) * uBlend;
    `;
    gpu = `
      let cb = straight(back);
      let cf = straight(front);
      let co = front.rgb * (1.0 - back.a) + back.rgb * (1.0 - front.a) + front.a * back.a * (${gpuB});
      out = vec4<f32>(co, blendedAlpha) * blendUniforms.uBlend;
    `;
  }

  const filter = new BlendModeFilter({
    gl: { functions: GL_FUNCTIONS, main: gl },
    gpu: { functions: GPU_FUNCTIONS, main: gpu },
  });
  // At the target's resolution, as the stage is drawn; its result is the
  // whole composite, back included, so it replaces what is there, which
  // alpha and erase make more transparent.
  filter.resolution = "inherit";
  filter.antialias = "inherit";
  filter.blendMode = "none";
  return filter;
}

/** One filter a mode, shared by every object blended so. */
const filters = new Map<string, Filter[]>();

/**
 * The filters that composite an object in `mode`: none for normal; for
 * layer one that only makes it a layer; for any other the mode's blend.
 */
export function blendFilters(mode: string): Filter[] | null {
  if (mode === "normal" || !(mode === "layer" || SEPARABLE[mode] || SPECIAL[mode])) {
    return null;
  }

  let made = filters.get(mode);
  if (!made) {
    if (mode === "layer") {
      const layer = new AlphaFilter({ alpha: 1 });
      layer.resolution = "inherit";
      layer.antialias = "inherit";
      made = [layer];
    } else {
      made = [blendFilter(mode)];
    }

    filters.set(mode, made);
  }

  return made;
}
