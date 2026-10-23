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
      // Animated meshes can keep one vertex buffer per animation frame. Byte budgets stay intact.
      context: new WebGLContext3D(gl, { maxBuffers: 4096 }),
      destroy: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
    };
  } catch (error) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    throw error;
  }
};
