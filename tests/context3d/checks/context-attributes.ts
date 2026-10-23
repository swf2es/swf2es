import { Context3DError } from "@swf2es/context3d";
import { WebGLContext3D } from "@swf2es/context3d/webgl";
import { check } from "./context.ts";

export function contextAttributes() {
  const gl = document.createElement("canvas").getContext("webgl2", { antialias: true });
  check(gl, "WebGL2 unavailable");
  let created = 0;
  const allocate = gl.createVertexArray.bind(gl);
  gl.createVertexArray = () => {
    created++;
    return allocate();
  };
  const attributes = gl.getContextAttributes();
  check(attributes, "WebGL2 attributes unavailable");
  if (!attributes.antialias) {
    // Drivers can decline MSAA; exercise rejection independently of that capability.
    gl.getContextAttributes = () => ({ ...attributes, antialias: true });
  }
  try {
    let error: unknown;
    try {
      new WebGLContext3D(gl);
    } catch (caught) {
      error = caught;
    }

    check(error instanceof Context3DError, "antialiased context was accepted");
    check(created === 0, "incompatible context allocated GPU handles");

    return { passed: true };
  } finally {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
