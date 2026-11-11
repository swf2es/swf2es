import { Context3DError } from "../errors.js";
import type { BufferState, VertexBinding } from "./buffers.js";

// Small ranges cost less to scan; changing ranges must not grow a buffer's cache without bound.
const MIN_RANGE = 128;
const RANGES = 16;

export function validateIndices(index: BufferState, first: number, count: number): number {
  if (
    index.checkedVersion === index.version &&
    index.checkedFirst === first &&
    index.checkedCount === count
  ) {
    return index.maximum;
  }

  const values = index.indices;
  if (!values) {
    throw new Context3DError("indexBuffer", "Context3D draw needs an index buffer");
  }

  let ranges = index.ranges;
  // Both parts are at most the buffer's length (524287), so these keys are exact and distinct.
  const key = count >= MIN_RANGE ? first * (values.length + 1) + count : -1;
  if (key >= 0 && index.checkedVersion === index.version) {
    if (!ranges && index.checkedCount >= MIN_RANGE) {
      ranges = new Map();
      ranges.set(index.checkedFirst * (values.length + 1) + index.checkedCount, index.maximum);
      index.ranges = ranges;
    }

    const maximum = ranges?.get(key);
    if (maximum !== undefined) {
      index.checkedFirst = first;
      index.checkedCount = count;
      index.maximum = maximum;
      return maximum;
    }
  }

  const end = first + count;
  let maximum = -1;
  for (let i = first; i < end; i++) {
    if (index.prefix < end && !index.uploaded[i]) {
      throw new Context3DError("indexData", "Context3D index not uploaded");
    }

    maximum = Math.max(maximum, values[i]);
  }

  index.checkedVersion = index.version;
  index.checkedFirst = first;
  index.checkedCount = count;
  index.maximum = maximum;
  if (key >= 0 && ranges && ranges.size < RANGES) {
    ranges.set(key, maximum);
  }

  return maximum;
}

export function validateVertices(
  vertex: BufferState,
  index: BufferState,
  binding: VertexBinding,
  first: number,
  count: number,
  maximum: number,
): void {
  if (maximum < vertex.prefix) {
    return;
  }
  if (maximum >= vertex.uploaded.length) {
    throw new Context3DError("vertexData", "Context3D vertex outside its buffer");
  }
  if (
    binding.checkedIndex === index &&
    binding.checkedIndexVersion === index.version &&
    binding.checkedVertexVersion === vertex.version &&
    binding.checkedFirst === first &&
    binding.checkedCount === count
  ) {
    return;
  }

  const values = index.indices as Uint16Array;
  for (let i = first; i < first + count; i++) {
    if (!vertex.uploaded[values[i]]) {
      throw new Context3DError("vertexStream", "Context3D vertex not uploaded");
    }
  }

  binding.checkedIndex = index;
  binding.checkedIndexVersion = index.version;
  binding.checkedVertexVersion = vertex.version;
  binding.checkedFirst = first;
  binding.checkedCount = count;
}
