// What the renderer (@swf2es/render) and Context3D share of a WebGL 2
// context: linking programs, and the cache of its state that its one owner
// sets it through (docs/renderer.md, "The backend").
export {
  beginProgram,
  endProgram,
  linkProgram,
  lostShader,
  type PendingProgram,
  ShaderError,
} from "./programs.js";
export { GlState } from "./state.js";
