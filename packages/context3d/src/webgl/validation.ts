import { Context3DError } from "../errors.js";
import type { BufferState, VertexBinding } from "./buffers.js";

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
