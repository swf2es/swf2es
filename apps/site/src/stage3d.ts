import { WebGLContext3D } from "@swf2es/context3d/webgl";
import type { Stage3DSurfaceFactory } from "@swf2es/web";

export const createStage3D: Stage3DSurfaceFactory = () => {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    throw new Error("WebGL2 is unavailable");
  }

  try {
    return {
      canvas,
      context: new WebGLContext3D(gl, {
        maxBufferBytes: 64 * 1024 * 1024,
        maxTextureBytes: 128 * 1024 * 1024,
        maxTargetDepthBytes: 16 * 1024 * 1024,
        maxTargetColorBytes: 16 * 1024 * 1024,
      }),
      destroy: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
    };
  } catch (error) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    throw error;
  }
};
