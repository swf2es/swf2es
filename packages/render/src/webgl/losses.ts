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
 * with the context not flagged, only for LOSS_GRACE_MS after the first of
 * a run of them, which a frame drawn without one ends, as does a grace's
 * time passing with none. One that outlives that is a fault of the
 * shaders after all: thrown, or drawn without, as before, till a frame is
 * drawn without a failure.
 */
export class LinkLosses {
  private readonly gl: WebGL2RenderingContext;
  /** When the first failure that said nothing came, the context not flagged lost; -1 for none. */
  private since = -1;
  /** When the last came. */
  private last = -1;
  /** Whether the run's failures are taken for the shaders' (concede). */
  private conceded = false;
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
    if (this.conceded) {
      this.last = now;
      return false;
    }

    // A failure a grace after the last, as after work given up on and nothing drawn since, starts
    // a run of its own: a loss long after a fault is a loss.
    if (this.since < 0 || now - this.last >= LOSS_GRACE_MS) {
      this.since = now;
    }

    this.last = now;
    return now - this.since < LOSS_GRACE_MS;
  }

  /** Whether a failure taken for a loss has outlived the grace, the context still not flagged lost. */
  get expired(): boolean {
    return this.since < 0 || performance.now() - this.since >= LOSS_GRACE_MS;
  }

  /**
   * The run's failures taken for the shaders', its grace over with the
   * context not flagged lost: those that follow too, till a frame is drawn
   * without one, which ends the run (WebGLBackend.resume).
   */
  concede(): void {
    this.conceded = true;
  }

  /** A frame drawn whole: one without a failure ends the run. */
  endFrame(): void {
    if (!this.failed) {
      this.since = -1;
      this.conceded = false;
    }

    this.failed = false;
  }

  /** The context restored: what failed before was its loss. */
  clear(): void {
    this.since = -1;
    this.conceded = false;
    this.failed = false;
  }
}
