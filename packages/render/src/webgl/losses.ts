import { lostShader, type ShaderError } from "@swf2es/context3d/device";

/**
 * How long link failures that say nothing are taken for a lost context
 * that is not flagged yet: Chrome flags a GPU process that died a task or
 * so later, which a host drawing more than once a task, or a busy page,
 * may stretch over a few frames.
 */
export const LOSS_GRACE_MS = 500;

/**
 * Which program links that failed are a lost context's (ShaderError.lost):
 * all, while the context is flagged lost; a failure that says nothing,
 * with the context not flagged, only for LOSS_GRACE_MS after the first
 * since a frame was drawn without one. One that outlives that is a fault
 * of the shaders after all: thrown, or drawn without, as before.
 */
export class LinkLosses {
  private readonly gl: WebGL2RenderingContext;
  /** When the first failure that said nothing came, the context not flagged lost; -1 for none. */
  private since = -1;
  /** Whether a failure came in the frame being drawn (endFrame). */
  private failed = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** Whether `e` is taken for a lost context's (see the class). */
  lost(e: unknown): e is ShaderError {
    if (!lostShader(e)) {
      return false;
    }

    if (this.gl.isContextLost()) {
      return true;
    }

    const now = performance.now();
    this.failed = true;
    if (this.since < 0) {
      this.since = now;
    }

    return now - this.since < LOSS_GRACE_MS;
  }

  /** Whether a failure taken for a loss has outlived the grace, the context still not flagged lost. */
  get expired(): boolean {
    return this.since < 0 || performance.now() - this.since >= LOSS_GRACE_MS;
  }

  /** A frame drawn whole: one without a failure starts the clock again for the next. */
  endFrame(): void {
    if (!this.failed) {
      this.since = -1;
    }

    this.failed = false;
  }

  /** The context restored: what failed before was its loss. */
  clear(): void {
    this.since = -1;
    this.failed = false;
  }
}
