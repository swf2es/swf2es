import type { Buffer3D } from "../backend.js";
import { range } from "./state.js";

export interface BufferState {
  handle: WebGLBuffer;
  indices: Uint16Array | null;
  uploaded: Uint8Array;
}

export interface VertexBinding {
  buffer: Buffer3D;
  offset: number;
  size: number;
  packed: boolean;
  valid: boolean;
}

export function uploadBuffer(
  gl: WebGL2RenderingContext,
  vao: WebGLVertexArrayObject,
  buffer: Buffer3D,
  state: BufferState,
  values: ArrayLike<number>,
  start: number,
  amount: number,
): void {
  const { count, stride } = buffer;
  const target = stride === 0 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
  const handle = state.handle;
  range(start, amount, count);
  const size = stride || 1;
  range(0, amount * size, values.length);
  const data = stride === 0 ? new Uint16Array(amount) : new Float32Array(amount * stride);
  for (let i = 0; i < data.length; i++) {
    data[i] = values[i];
  }

  state.indices?.set(data, start);
  state.uploaded.fill(1, start, start + amount);
  gl.bindVertexArray(vao);
  gl.bindBuffer(target, handle);
  gl.bufferSubData(target, start * size * (stride === 0 ? 2 : 4), data);
}

export function uploadBufferBytes(
  gl: WebGL2RenderingContext,
  vao: WebGLVertexArrayObject,
  buffer: Buffer3D,
  state: BufferState,
  data: Uint8Array,
  offset: number,
  start: number,
  amount: number,
): void {
  const { count, stride } = buffer;
  const target = stride === 0 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
  const handle = state.handle;
  range(start, amount, count);
  const bytesPerEntry = stride === 0 ? 2 : stride * 4;
  const length = amount * bytesPerEntry;
  range(offset, length, data.length);
  // In WebGL2, a zero source length uploads the rest of the array.
  if (amount === 0) {
    return;
  }

  const indices = state.indices;
  if (indices) {
    for (let i = 0; i < amount; i++) {
      const at = offset + i * 2;
      indices[start + i] = data[at] | (data[at + 1] << 8);
    }
  }

  state.uploaded.fill(1, start, start + amount);
  gl.bindVertexArray(vao);
  gl.bindBuffer(target, handle);
  gl.bufferSubData(target, start * bytesPerEntry, data, offset, length);
}
