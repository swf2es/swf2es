import type { GlRenderTargetAdaptor, RenderTarget, Texture, WebGLRenderer } from "pixi.js";

const installed = new WeakSet<WebGLRenderer>();

/** Resolve a blend's backdrop where it is read, and the stage once on presentation. */
export function boundedResolves(renderer: WebGLRenderer): void {
  if (installed.has(renderer)) {
    return;
  }

  installed.add(renderer);
  const filter = renderer.filter as unknown as {
    _setupFilterTextures(...args: unknown[]): void;
    _setupBindGroupsAndRender(...args: unknown[]): void;
  };
  const adaptor = renderer.renderTarget.adaptor as GlRenderTargetAdaptor;
  const setup = filter._setupFilterTextures;
  const apply = filter._setupBindGroupsAndRender;
  const copy = adaptor.copyToTexture;
  const finish = adaptor.finishRenderPass;
  let preparing = 0;
  let applying = 0;
  let copying: {
    source: RenderTarget;
    origin: { x: number; y: number };
    size: { width: number; height: number };
  } | null = null;

  filter._setupFilterTextures = function (...args) {
    preparing++;
    try {
      setup.apply(this, args);
    } finally {
      preparing--;
    }
  };
  filter._setupBindGroupsAndRender = function (...args) {
    applying++;
    try {
      apply.apply(this, args);
    } finally {
      applying--;
    }
  };
  adaptor.copyToTexture = function (source, destination, origin, size, to) {
    const previous = copying;
    copying = { source, origin, size };
    try {
      return copy.call(this, source, destination, origin, size, to);
    } finally {
      copying = previous;
    }
  };
  adaptor.finishRenderPass = function (target) {
    if (!target) {
      return finish.call(this, target);
    }

    const gpu = renderer.renderTarget.getGpuRenderTarget(target);
    if (!gpu.msaa || target.colorAttachments.length === 0) {
      return finish.call(this, target);
    }

    // The copy has already been clipped by render/blend.ts. Keep the resolve at
    // the source coordinates: copyTexSubImage2D reads that same rectangle.
    if (copying?.source === target) {
      const { x, y } = copying.origin;
      const { width, height } = copying.size;
      const gl = renderer.gl;
      this.bindFramebuffer(gpu.resolveTargetFramebuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.framebuffer);
      gl.blitFramebuffer(
        x,
        y,
        x + width,
        y + height,
        x,
        y,
        x + width,
        y + height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      this.bindFramebuffer(gpu.framebuffer);
      return;
    }

    // Setup resolves before copying the backdrop, which resolves it again.
    // The main back buffer is read through those copies until presentation.
    // Intermediate filter outputs still resolve immediately for sampling.
    const back = (renderer.backBuffer as unknown as { _backBufferTexture?: Texture })
      ?._backBufferTexture;
    if (preparing || (applying && back && target.colorTexture === back.source)) {
      return;
    }

    finish.call(this, target);
  };
}
