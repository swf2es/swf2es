import { type Handle, Registry } from "./registry.js";

/**
 * How many frames a geometry may go undrawn before it is let go of: a
 * pool's object or a loop's rarer frame comes back within a few seconds.
 */
export const IDLE_FRAMES = 300;

/**
 * Frames of the registry (Geometries.frame) a geometry stands copied to the GPU before its
 * arrays are let go of (release): one drawn anew each frame, as a script's drawing redrawn every
 * frame is, goes whole before then, and costs the backend no copy of its indices; copying a
 * thousand such geometries' indices a frame took about a millisecond. An owner that reads a
 * geometry's arrays after adding it does so within these frames, or asks for them again
 * (rebuild).
 */
export const RELEASE_FRAMES = 3;

/** Floats a vertex of advanced text's glyph quads (GeometryData.glyphs). */
export const GLYPH_FLOATS = 18;

/**
 * A texel a vertex may give in place of where it samples: the stage's
 * pixel it lands on instead, one texel each, read at the pixel's centre, as
 * Flash draws a repeating bitmap whose matrix collapses the plane, from the
 * stage's corner whatever the transform. Below it, any texel takes the same.
 */
export const TARGET_TEXEL = -1e30;

/**
 * Whether any of a fill's vertices samples the stage's pixel (TARGET_TEXEL),
 * which the stage fill program alone draws.
 */
export function samplesStage(data: GeometryData): boolean {
  const texels = data.texels;
  if (!texels || data.depths) {
    return false;
  }

  for (let k = 0; k < texels.length; k += 2) {
    if (texels[k] <= TARGET_TEXEL / 2) {
      return true;
    }
  }

  return false;
}

/** A geometry as its owner holds it: its id, and the generation the id had, which a reused id moves on. */
export type GeometryHandle = Handle;

/**
 * Triangles to draw under a row's transform: positions on the stage in
 * pixels, two floats a vertex; each vertex' straight colour, its bytes red,
 * green, blue and alpha from the lowest; where it samples a texture, where
 * in texels, two floats a vertex, which a draw divides by the texture's
 * size; and indices into the vertices, three a triangle. The backend copies
 * them into its atlas once.
 */
export interface GeometryData {
  positions: Float32Array;
  /** None for a mesh, whose depths take their place. */
  colors: Uint32Array;
  /**
   * A mesh's (MESH) are its u and v from 0 to 1, which its program reads as
   * they are. A fill's vertex whose u is TARGET_TEXEL samples the stage's
   * pixel, which no mesh's does.
   */
  texels?: Float32Array;
  /** A mesh's depth at each vertex, its t, in place of its colour. */
  depths?: Float32Array;
  /**
   * Advanced text's glyph quads: GLYPH_FLOATS floats a vertex, its position
   * first, as its positions have it, then its glyph's pen and tables,
   * outline bounds and corner, segments and size, and colour; and the
   * text's mode and cutoff tables, which its draw takes as uniforms. Drawn
   * by the glyph program (webgl/programs.ts, glyphsVertex), each pixel of a
   * quad covered by its distance to the glyph's outline, in the outlines'
   * segments (WebGLBackend.uploadOutlines), as adl covers it.
   */
  glyphs?: { vertices: Float32Array; mode: Float32Array; table: Float32Array };
  indices: Uint32Array;
  /**
   * No part of it over another: a bitmap's quad, one fill's triangles, or
   * fills found to meet without overlapping (markFlat). Alone in a blend
   * mode's layer, such a geometry is drawn straight onto what is below it,
   * as blending it pixel by pixel blends each pixel once.
   */
  flat?: boolean;
}

/**
 * Every geometry a scene list may name, by id. What goes undrawn for
 * IDLE_FRAMES is let go of; its owner finds it gone by its handle and adds
 * it again. The backend takes what was added and removed since it last
 * looked (taken), and keeps its own copies: once it has copied a geometry's
 * arrays into a context not known to be lost, the registry lets go of them (release),
 * unless their owner changes them in place (add's `keep`). Nothing else
 * releases them, so a view with no GPU backend, as in node, keeps every
 * geometry's arrays. A reader that needs arrays let go of, a lost context
 * or a CPU rasterizer alike, asks for them again through one entry point,
 * rebuild: the geometry is removed, and its owner adds it again with its
 * arrays as it next draws it, as it does an expired one.
 */
export class Geometries extends Registry {
  /** Changes only when a handle can have become stale, including expiry and context loss. */
  removalVersion = 0;
  private readonly data: (GeometryData | null)[] = [];
  /** Whether each geometry's arrays stay held once copied, as their owner changes them in place (update). */
  private readonly kept: boolean[] = [];
  /** Whether each geometry is flat (GeometryData.flat), its arrays held or not. */
  private readonly flats: boolean[] = [];
  /** Each geometry's box: its positions' least x and y, then their greatest. */
  private boxes = new Float32Array(1024);
  /** Added since the backend last took them. */
  added: number[] = [];
  /** Changed in place since the backend last took them (update). */
  updated: number[] = [];
  /** Found flat since the backend last took them (markFlat). */
  flattened: number[] = [];

  /**
   * `data` added, for the backend to copy. Its arrays are let go of once
   * copied (release) unless `keep`, for an owner that changes them in place
   * (update).
   */
  add(data: GeometryData, keep = false): GeometryHandle {
    const handle = this.hold(IDLE_FRAMES);
    const id = handle.id;
    this.data[id] = data;
    this.kept[id] = keep;
    this.flats[id] = data.flat === true;
    this.added.push(id);
    this.measure(id);
    return handle;
  }

  /**
   * Geometry `id`'s arrays changed in place, their lengths as they were: its
   * box measured again, and its vertices copied again where they lie. Only
   * for a geometry added to be kept, and only its vertices: the backend
   * keeps the indices it was added with (the atlas's Place.local).
   */
  update(id: number): void {
    if (this.data[id] && this.kept[id]) {
      this.measure(id);
      this.updated.push(id);
    }
  }

  /**
   * Geometry `id`'s arrays copied by the backend into a context not known to be lost,
   * which keeps what it needs of them: let go of, unless they were added to
   * be kept. Its box and flatness stay. Only the GPU backend calls it, once
   * the copy is made (webgl/atlas.ts).
   */
  release(id: number): void {
    if (!this.kept[id]) {
      this.data[id] = null;
    }
  }

  /** Whether geometry `id` is held but its arrays were let go of (release). */
  released(id: number): boolean {
    return this.holds(id) && !this.data[id];
  }

  /**
   * Geometry `id`'s arrays wanted again, by any reader of them: where they
   * were let go of (release), the geometry is removed, for its owner to add
   * it again with its arrays as it next draws it (tessellated and stroked
   * again, or from a slow layer's kept triangles), as an expired one is;
   * its handle then reads dead. True where it was removed so; false where
   * its arrays are held (get), or it is not held at all. Called outside a
   * frame's walk, or with the view's spans dropped after: a frame walked
   * or kept as spans (scene/spans.ts) before the call names the removed id
   * in its scene list, which then draws nothing for it. An owner remaking
   * its own geometry as it is next asked for it, before it is drawn, may
   * call it mid-walk (Parts.partsOf).
   */
  rebuild(id: number): boolean {
    if (!this.released(id)) {
      return false;
    }

    this.remove(id);
    return true;
  }

  /**
   * Geometry `id` found flat (GeometryData.flat) after it was added, for
   * the backend to draw it so: its flag alone taken again, not its vertices.
   */
  markFlat(id: number): void {
    if (this.holds(id) && !this.flats[id]) {
      this.flats[id] = true;
      const data = this.data[id];
      if (data) {
        data.flat = true;
      }

      this.flattened.push(id);
    }
  }

  /** Whether geometry `id` is flat (GeometryData.flat, markFlat). */
  flat(id: number): boolean {
    return this.flats[id] === true;
  }

  /**
   * The context was lost, and the backend's copies with it: the geometries
   * whose arrays were let go of rebuilt (rebuild), and those whose arrays
   * are held added again as they are.
   */
  override lost(): void {
    for (let id = 0; id < this.size; id++) {
      this.rebuild(id);
    }

    this.added.length = 0;
    this.removed.length = 0;
    this.updated.length = 0;
    this.flattened.length = 0;
    for (let id = 0; id < this.size; id++) {
      if (this.holds(id)) {
        this.added.push(id);
      }
    }
  }

  private measure(id: number): void {
    const data = this.data[id] as GeometryData;
    if (id * 4 >= this.boxes.length) {
      const grown = new Float32Array(Math.max(this.boxes.length * 2, id * 4 + 4));
      grown.set(this.boxes);
      this.boxes = grown;
    }

    const p = data.positions;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]);
      y0 = Math.min(y0, p[i + 1]);
      x1 = Math.max(x1, p[i]);
      y1 = Math.max(y1, p[i + 1]);
    }

    const box = this.boxes;
    box[id * 4] = x0;
    box[id * 4 + 1] = y0;
    box[id * 4 + 2] = x1;
    box[id * 4 + 3] = y1;
  }

  /**
   * The boxes of every geometry, four floats from `id * 4`: least x and y,
   * greatest x and y; a geometry of no vertices has its least past its
   * greatest.
   */
  get box(): Float32Array {
    return this.boxes;
  }

  /** Geometry `id`'s arrays, null once let go of (release) or for one not held. */
  get(id: number): GeometryData | null {
    return this.data[id] ?? null;
  }

  protected override dropped(id: number): void {
    this.removalVersion++;
    this.data[id] = null;
    this.kept[id] = false;
    this.flats[id] = false;
  }
}
