import { WebGLContext3D } from "@swf2es/context3d/webgl";

import { check, color, create, rejects } from "./context.ts";

export function resourceLimits(): { passed: boolean } {
  const options = {
    maxBuffers: 2,
    maxPrograms: 1,
    maxTextures: 1,
    maxBufferBytes: 12,
    maxTextureBytes: 256,
  };
  const owned = create(options);
  const c = owned.backend;
  try {
    const names = [
      "maxBuffers",
      "maxVertexBuffers",
      "maxIndexBuffers",
      "maxPrograms",
      "maxTextures",
      "max2DTextures",
      "maxRectangleTextures",
      "maxCubeTextures",
      "maxBufferBytes",
      "maxTextureBytes",
      "maxTargetDepthBytes",
      "maxTargetColorBytes",
    ] as const;
    const invalid = [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1];
    const handles = owned.created;
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < invalid.length; j++) {
        rejects(() => new WebGLContext3D(owned.gl, { [names[i]]: invalid[j] }));
        check(owned.created === handles, "invalid limits allocated GPU handles");
      }
    }

    const indices = c.createBuffer(4, 0);
    const vertex = c.createBuffer(1, 1);
    const allocated = owned.created;
    options.maxBuffers = 100;
    options.maxBufferBytes = 100;
    rejects(() => c.createBuffer(1, 0));
    check(
      owned.created === allocated,
      "buffer count rejection allocated handles or reread options",
    );
    vertex.dispose();
    const afterDispose = owned.created;
    rejects(() => c.createBuffer(3, 0));
    check(owned.created === afterDispose, "buffer byte rejection allocated GPU handles");
    const replacement = c.createBuffer(2, 0);
    replacement.dispose();
    replacement.dispose();
    indices.dispose();
    c.createBuffer(3, 1).dispose();

    const program = c.createProgram();
    rejects(() => c.createProgram());
    program.dispose();
    c.createProgram().dispose();

    const rectangle = c.createRectangleTexture(8, 8);
    const textureHandles = owned.created;
    rejects(() => c.createRectangleTexture(8, 8));
    check(owned.created === textureHandles, "texture count rejection allocated GPU handles");
    rectangle.dispose();
    rejects(() => c.createTexture(8, 8));
    check(owned.created === textureHandles, "texture mip budget rejection allocated GPU handles");
    c.createRectangleTexture(8, 8).dispose();
    check(owned.gl.getError() === owned.gl.NO_ERROR, "resource quotas changed GL state");
  } finally {
    c.dispose();
    check(owned.live.size === 0, "budget test retained GPU handles");
    owned.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const depth = create({ maxTextures: 2, maxTextureBytes: 512, maxTargetDepthBytes: 256 });
  try {
    const c = depth.backend;
    c.configure(32, 32);
    const first = c.createRectangleTexture(8, 8);
    const second = c.createRectangleTexture(8, 8);
    c.setRenderTarget(first, true);
    c.clear(0, 1, 0, 1);
    const handles = depth.live.size;
    rejects(() => c.setRenderTarget(second, true));
    check(depth.live.size === handles, "target depth quota rejection leaked handles");
    const pixel = new Uint8Array(4);
    depth.gl.readPixels(0, 0, 1, 1, depth.gl.RGBA, depth.gl.UNSIGNED_BYTE, pixel);
    check(color(pixel, 0, 0, 1) === "ff00ff00", "target depth failure lost the old target");
    first.dispose();
    c.setRenderTarget(second, true);
    c.clear(1, 0, 0, 1);
    depth.gl.readPixels(0, 0, 1, 1, depth.gl.RGBA, depth.gl.UNSIGNED_BYTE, pixel);
    check(color(pixel, 0, 0, 1) === "ffff0000", "target depth budget was not released");
    const reused = depth.created;
    c.setRenderTarget(second, false);
    c.setRenderTarget(second, true);
    check(depth.created === reused, "cached depth storage was charged or allocated again");
    check(depth.gl.getError() === depth.gl.NO_ERROR, "target depth quotas changed GL state");
  } finally {
    depth.backend.dispose();
    check(depth.live.size === 0, "target depth budget retained handles");
    depth.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const cube = create({ maxTextureBytes: 6 * 340, maxBuffers: 0, maxPrograms: 0 });
  try {
    const c = cube.backend;
    rejects(() => c.createBuffer(1, 0));
    rejects(() => c.createProgram());
    const texture = c.createTexture(8, 8, true);
    const handles = cube.created;
    rejects(() => c.createTexture(8, 8));
    check(cube.created === handles, "cube mip budget rejection allocated handles");
    texture.dispose();
    c.createTexture(8, 8).dispose();
  } finally {
    cube.backend.dispose();
    check(cube.live.size === 0, "cube budget retained handles");
    cube.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  for (let raised = 0; raised < 2; raised++) {
    const entry = create(raised ? { maxIndexBuffers: 4097 } : { maxIndexBuffers: undefined });
    try {
      for (let i = 0; i < 4096; i++) {
        entry.backend.createBuffer(1, 0);
      }
      if (raised) {
        entry.backend.createBuffer(1, 0);
      } else {
        rejects(() => entry.backend.createBuffer(1, 0));
      }
      entry.backend.dispose();
      check(entry.live.size === 0, "buffer count budget retained handles");
    } finally {
      entry.backend.dispose();
      entry.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }

  return { passed: true };
}
