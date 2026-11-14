import type { Buffer3D } from "../backend.js";
import { Context3DError } from "../errors.js";

import type { WebGLContext3D } from "./context.js";
import { range } from "./state.js";

export interface BufferState {
  handle: WebGLBuffer;
  indices: Uint16Array | null;
  uploaded: Uint8Array;
  prefix: number;
  version: number;
  checkedVersion: number;
  checkedFirst: number;
  checkedCount: number;
  maximum: number;
  ranges: Map<number, number> | null;
}

export interface VertexBinding {
  buffer: Buffer3D;
  offset: number;
  size: number;
  packed: boolean;
  valid: boolean;
  /** Layout stored in the owned VAO, independent of whether this attribute is enabled. */
  applied: boolean;
  checkedIndex: BufferState | null;
  checkedIndexVersion: number;
  checkedVertexVersion: number;
  checkedFirst: number;
  checkedCount: number;
}

function uploaded(state: BufferState, start: number, amount: number): void {
  if (amount === 0) {
    return;
  }

  state.uploaded.fill(1, start, start + amount);
  state.version++;
  state.ranges?.clear();
  while (state.prefix < state.uploaded.length && state.uploaded[state.prefix]) {
    state.prefix++;
  }
}

function uploadBuffer(
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
  uploaded(state, start, amount);
  gl.bindVertexArray(vao);
  gl.bindBuffer(target, handle);
  gl.bufferSubData(target, start * size * (stride === 0 ? 2 : 4), data);
}

function uploadBufferBytes(
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

  uploaded(state, start, amount);
  gl.bindVertexArray(vao);
  gl.bindBuffer(target, handle);
  gl.bufferSubData(target, start * bytesPerEntry, data, offset, length);
}

export function allocateBuffer(
  ctx: WebGLContext3D,
  count: number,
  stride: number,
  dynamic: boolean,
): Buffer3D {
  ctx.alive();
  range(1, count - 1, stride === 0 ? 524287 : 65535);
  range(0, stride, 64);
  const countLimit = stride === 0 ? ctx.limits.maxIndexBuffers : ctx.limits.maxVertexBuffers;
  const used = stride === 0 ? ctx.buffers.size - ctx.vertexBuffers : ctx.vertexBuffers;
  if (ctx.buffers.size >= ctx.limits.maxBuffers || used >= countLimit) {
    throw new Context3DError("limit", "Context3D experiment: buffer limit");
  }

  const bytes = count * (stride === 0 ? 2 : stride * 4);
  const usedBytes = stride === 0 ? ctx.bufferBytes - ctx.vertexBufferBytes : ctx.vertexBufferBytes;
  const byteLimit = stride === 0 ? ctx.limits.maxIndexBufferBytes : ctx.limits.maxVertexBufferBytes;
  if (ctx.bufferBytes + bytes > ctx.limits.maxBufferBytes || usedBytes + bytes > byteLimit) {
    throw new Context3DError("limit", "Context3D experiment: buffer memory limit");
  }

  const gl = ctx.gl;
  const handle = gl.createBuffer();
  if (!handle) {
    throw new Context3DError("bufferAllocation", "Context3D experiment: cannot allocate buffer");
  }

  const target = stride === 0 ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER;
  if (stride === 0) {
    ctx.indexBuffer = null;
  }
  gl.bindVertexArray(ctx.vao);
  gl.bindBuffer(target, handle);
  gl.bufferData(target, bytes, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  const state: BufferState = {
    handle,
    indices: stride === 0 ? new Uint16Array(count) : null,
    uploaded: new Uint8Array(count),
    prefix: 0,
    version: 0,
    checkedVersion: -1,
    checkedFirst: 0,
    checkedCount: 0,
    maximum: -1,
    ranges: null,
  };
  const buffer: Buffer3D = {
    count,
    stride,
    upload: (values, start, amount) => {
      ctx.alive();
      ctx.buffer(buffer);
      try {
        uploadBuffer(gl, ctx.vao, buffer, state, values, start, amount);
      } finally {
        // Source getters can draw before the upload replaces the VAO's index binding.
        if (stride === 0) {
          ctx.indexBuffer = null;
        }
      }
    },
    uploadBytes: (data, offset, start, amount) => {
      ctx.alive();
      ctx.buffer(buffer);
      try {
        uploadBufferBytes(gl, ctx.vao, buffer, state, data, offset, start, amount);
      } finally {
        if (stride === 0) {
          ctx.indexBuffer = null;
        }
      }
    },
    dispose: () => {
      if (!ctx.buffers.delete(buffer)) {
        return;
      }

      if (ctx.indexBuffer === handle) {
        ctx.indexBuffer = null;
      }
      gl.deleteBuffer(handle);
      ctx.bufferBytes -= bytes;
      if (stride !== 0) {
        ctx.vertexBuffers--;
        ctx.vertexBufferBytes -= bytes;
      }
      state.indices = null;
      state.ranges = null;
      state.uploaded = new Uint8Array(0);
      for (let i = 0; i < ctx.vertices.length; i++) {
        const binding = ctx.vertices[i];
        if (binding?.buffer === buffer) {
          ctx.vertices[i] = null;
        } else if (binding?.checkedIndex === state) {
          binding.checkedIndex = null;
        }
      }
    },
  };
  ctx.buffers.set(buffer, state);
  if (stride !== 0) {
    ctx.vertexBuffers++;
    ctx.vertexBufferBytes += bytes;
  }
  ctx.bufferBytes += bytes;
  return buffer;
}
