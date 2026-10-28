// Blend modes as Flash composites them (docs/architecture.md, "Blend
// modes"): the object drawn as a layer, its children together, then that
// layer blended with what is below by the mode's formula, which a filter
// that reads the back buffer computes. Colours are premultiplied.
import {
  BlendModeFilter,
  type Bounds,
  Container,
  type Filter,
  type FilterInstruction,
  type FilterSystem,
} from "pixi.js";

/**
 * A filter that keeps the area its object was last measured at, to give
 * it again while nothing in the object changed but where it is
 * (FilterChain): Pixi measured every filtered object, all of it, on every
 * frame, a crowd's glows and their characters' every part.
 */
export interface AreaKeeper {
  /** Into `bounds` the area kept, moved as `container` has moved since; false where none stands. */
  keptArea(container: Container, bounds: Bounds): boolean;
  /** Keep `bounds`, the area just measured of `container`. */
  keepArea(container: Container, bounds: Bounds): void;
}

/** The keeper of the instruction's area, where it is measured as Pixi measures a container. */
function keeperOf(instruction: FilterInstruction): AreaKeeper | null {
  const container = instruction.container;
  const first = instruction.filterEffect.filters?.[0] as Partial<AreaKeeper> | undefined;
  if (
    !container ||
    !first?.keptArea ||
    instruction.renderables ||
    instruction.filterEffect.filterArea
  ) {
    return null;
  }

  const group = container.renderGroup || container.parentRenderGroup;
  return group?.cacheToLocalTransform ? null : (first as AreaKeeper);
}

/** What a filter's area is measured from, and whether a mask outside it bounds something in it. */
const areaWatch: { root: Container | null; outside: boolean } = {
  root: null,
  outside: false,
};

/** Whether `inner` is `outer` or under it. */
function within(outer: Container, inner: Container): boolean {
  for (let p: Container | null = inner; p; p = p.parent) {
    if (p === outer) {
      return true;
    }
  }

  return false;
}

/**
 * A masked container Pixi's bounds walk measured (render/hooks.ts): a mask
 * from outside the area watched may bound what is in it, and move as
 * nothing in it changes, so that area is not kept.
 */
export function noteMask(container: Container): void {
  const watch = areaWatch.root;
  if (watch && !areaWatch.outside) {
    const mask = container.mask;
    if (mask instanceof Container && !within(watch, mask)) {
      areaWatch.outside = true;
    }
  }
}

/**
 * The area a filter instruction is applied to, measured in place of Pixi's
 * filter system (render/hooks.ts): a filter that keeps its object's area
 * gives it again while the object has only moved, and keeps the area
 * measured otherwise, unless a mask from outside bounds something in it.
 */
export function measureFilterArea(
  instruction: FilterInstruction,
  bounds: Bounds,
  system: FilterSystem,
): void {
  measureArea(instruction, bounds, system);
  // The area known, a filter that pads past what the GPU can draw round it pads less.
  for (const filter of instruction.filterEffect.filters ?? []) {
    (filter as Partial<PaddingFitter>).fitPadding?.(bounds, system, instruction);
  }
}

/** A filter whose padding depends on the area it pads and on what the renderer can draw. */
export interface PaddingFitter {
  /** Its padding for `bounds`, as the filter system will pad them, for `instruction`'s push. */
  fitPadding(bounds: Bounds, system: FilterSystem, instruction?: FilterInstruction): void;
}

function measureArea(instruction: FilterInstruction, bounds: Bounds, system: FilterSystem): void {
  const keeper = keeperOf(instruction);
  const container = instruction.container as Container;
  if (keeper?.keptArea(container, bounds)) {
    return;
  }

  areaWatch.root = keeper ? container : null;
  areaWatch.outside = false;
  try {
    system.measureFilterArea(instruction, bounds);
    // An object that draws nothing is filtered into nothing, as adl draws a glow or a shadow of
    // it (the `filters-empty` case). Pixi measures it as a point at its group's origin, which its
    // padding made an area it ran every filter on: emptied, the push skips them.
    if (
      !instruction.renderables &&
      !instruction.filterEffect.filterArea &&
      !(bounds.maxX > bounds.minX && bounds.maxY > bounds.minY)
    ) {
      bounds.clear();
      return;
    }

    if (keeper && !areaWatch.outside) {
      keeper.keepArea(container, bounds);
    }
  } finally {
    areaWatch.root = null;
  }
}

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
  // What is below less the object, its alpha the two's as the object over it: over a layer's
  // clear ground, adl's subtract leaves the object's alpha in black.
  subtract: [
    "vec4(max(back.rgb - front.rgb, 0.0), front.a + back.a * (1.0 - front.a))",
    "vec4<f32>(max(back.rgb - front.rgb, vec3<f32>(0.0)), front.a + back.a * (1.0 - front.a))",
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
 * The filters that composite an object in `mode`: none for normal or layer, whose colour
 * chain already isolates it (view.ts); for any other the mode's blend.
 */
export function blendFilters(mode: string): Filter[] | null {
  if (!(SEPARABLE[mode] || SPECIAL[mode])) {
    return null;
  }

  let made = filters.get(mode);
  if (!made) {
    made = [blendFilter(mode)];
    filters.set(mode, made);
  }

  return made;
}
