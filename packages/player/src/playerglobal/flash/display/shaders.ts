// What a Shader's kernel runs with, read from its ShaderData as adl reads
// it: each parameter's numbers and each input's image. A ShaderJob reads
// them as it starts; a ShaderFilter, a blend shader and a shader fill as
// they are set, and draw with those after, whatever the script sets later
// (the shader-filters and shader-blends cases).
import {
  PBJ_TYPE_SIZES,
  PBJ_TYPES,
  type PbjKernel,
  PbjOp,
  type PbjParameter,
  type PbjSample,
  pbjFloatType,
} from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { OUT_COORD, type ShaderImage, type ShaderUse } from "../../../bitmap/pixel-bender.js";
import type { Scripting } from "../../../scripting.js";
import { storeOf } from "./BitmapData.js";
import { shaderClasses } from "./ShaderInput.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

/** A parameter value's number as its register takes it: float32, or an int as SSE truncates one. */
function numberOf(v: number, float: boolean): number {
  if (float) {
    return Math.fround(v);
  }

  const t = Math.trunc(v);
  return t >= -2147483648 && t <= 2147483647 ? t : -2147483648;
}

/** The kernel a Shader holds: its ShaderData's, or null for none. */
export function kernelOfShader(shader: Value): { data: AsObject; kernel: PbjKernel } | null {
  const data: AsObject | null = (shader as AsObject | null)?.$data ?? null;
  const kernel: PbjKernel | undefined = data?.$kernel;
  return data && kernel ? { data, kernel } : null;
}

/**
 * A parameter's numbers: those of the ShaderParameter of its name, where
 * one of its type is there, else its default, as adl takes them; each a
 * number, or ArgumentError 2004, as many as its type holds, 0 past the
 * Array's end.
 */
export function parameterValues(s: Scripting, data: AsObject, p: PbjParameter): number[] {
  const classes = shaderClasses(s);
  const size = PBJ_TYPE_SIZES[p.type] ?? 0;
  const float = pbjFloatType(p.type);
  const own = data.$d.get(p.name);
  let value: Value;
  if (s.rt.isInstance(own, classes.shaderParameter) && own.$type === (PBJ_TYPES[p.type] ?? null)) {
    value = own.$value ?? null;
  } else {
    const fallback = p.metadata.filter((m) => m.key === "defaultValue").pop();
    value = fallback && typeof fallback.value !== "string" ? s.rt.array([...fallback.value]) : null;
  }

  const values: number[] = [];
  const items: Value[] = s.rt.isInstance(value, classes.array) ? (value as AsObject).$a : [];
  for (let k = 0; k < size; k++) {
    if (k >= items.length) {
      values.push(0);
      continue;
    }

    const item = items[k];
    if (typeof item !== "number") {
      throw s.rt.error("ArgumentError", 2004);
    }

    values.push(numberOf(item as number, float));
  }

  return values;
}

/** Every input parameter's numbers, but _OutCoord's, which each pixel sets. */
export function kernelValues(
  s: Scripting,
  data: AsObject,
  kernel: PbjKernel,
): Map<PbjParameter, number[]> {
  const values = new Map<PbjParameter, number[]>();
  for (const p of kernel.parameters) {
    if (!p.output && p.name !== OUT_COORD) {
      values.set(p, parameterValues(s, data, p));
    }
  }

  return values;
}

/**
 * An input's image, read now: a BitmapData's pixels, or as many floats
 * as its size needs; a ByteArray's position is moved past them by
 * `read`, once nothing refuses the job, as adl leaves it where it was
 * then. `copy` takes a BitmapData's pixels as a copy, for a use that
 * draws with them later.
 */
export function inputImage(
  s: Scripting,
  data: AsObject,
  name: string,
  channels: number,
  read: (() => void)[],
  copy = false,
): ShaderImage {
  const classes = shaderClasses(s);
  const refuse = (id: number, ...args: Value[]): never => {
    throw s.rt.error("ArgumentError", id, ...args);
  };
  const own = data.$d.get(name);
  if (!s.rt.isInstance(own, classes.shaderInput)) {
    refuse(2167);
  }

  const o = own as AsObject;
  const input: Value = o.$input ?? null;
  if (input === null) {
    refuse(2164, name);
  }

  if (s.rt.isInstance(input, classes.bitmapData)) {
    const store = storeOf(s, input as AsObject);
    const pixels = copy ? store.readable.slice() : store.readable;
    return { width: store.width, height: store.height, pixels, channels };
  }

  const width: number = o.$width ?? 0;
  const height: number = o.$height ?? 0;
  if (width <= 0 || height <= 0) {
    refuse(2166, name);
  }

  // Allocated once the input is known to hold them, whatever size the script set.
  const count = width * height * channels;
  if (s.rt.isInstance(input, classes.vector)) {
    const items: number[] = (input as AsObject).$a;
    if (items.length < count) {
      refuse(2165, name);
    }

    return { width, height, floats: Float32Array.from(items.slice(0, count)), channels };
  }

  // From the start, whatever the position, which is left past what was read.
  const bytes = avm2.bytesOf(s.rt, input as AsObject);
  if (bytes.length < count * 4) {
    refuse(2165, name);
  }

  const floats = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    floats[i] = bytes.view.getFloat32(i * 4, bytes.littleEndian);
  }

  read.push(() => {
    bytes.position = count * 4;
  });
  return { width, height, floats, channels };
}

/**
 * What a ShaderFilter, a blend shader or a shader fill draws with, read as
 * it is set: `bound` inputs, the first ones, are the use's own (a filter's
 * object, a blend's background and foreground), and the rest must be
 * set; each needs `bound` inputs at least (2167), and a filter and a blend
 * a kernel of four channels out (2162). Its BitmapData inputs are copies.
 */
export function shaderUse(s: Scripting, shader: Value, bound: number): ShaderUse {
  const found = kernelOfShader(shader) as { data: AsObject; kernel: PbjKernel };
  const { data, kernel } = found;
  const outputs = kernel.parameters.filter((p) => p.output);
  if (bound > 0 && outputs[outputs.length - 1]?.type !== 0x4) {
    throw s.rt.error("ArgumentError", 2162);
  }

  if (kernel.inputs.length < bound) {
    throw s.rt.error("ArgumentError", 2167);
  }

  const images = new Map<number, ShaderImage>();
  const read: (() => void)[] = [];
  for (const input of kernel.inputs.slice(bound)) {
    images.set(input.index, inputImage(s, data, input.name, input.channels, read, true));
  }

  // A texture sampled that no input declares, as a job refuses it.
  for (const op of kernel.operations) {
    if (
      (op.op === PbjOp.sampleNearest || op.op === PbjOp.sampleLinear) &&
      !kernel.inputs.some((input) => input.index === (op as PbjSample).texture)
    ) {
      throw s.rt.error("ArgumentError", 2167);
    }
  }

  const values = kernelValues(s, data, kernel);
  for (const move of read) {
    move();
  }

  return { kernel, values, images };
}
