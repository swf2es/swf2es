import { Context3DError } from "@swf2es/context3d";
import { check, create } from "./context.ts";

export function byteBudgets() {
  const owned = create({
    maxBufferBytes: 44,
    maxVertexBufferBytes: 32,
    maxIndexBufferBytes: 12,
    maxTextureBytes: 5272,
    max2DTextureBytes: 768,
    maxRectangleTextureBytes: 512,
    maxCubeTextureBytes: 4608,
  });
  const c = owned.backend;
  const limited = (operation: () => unknown): void => {
    const before = owned.created;
    let error: unknown;
    try {
      operation();
    } catch (caught) {
      error = caught;
    }
    check(error instanceof Context3DError && error.reason === "limit", "wrong budget error");
    check(owned.created === before, "budget rejection allocated a handle");
  };
  try {
    const factories = [
      () => c.createBuffer(1, 4),
      () => c.createBuffer(3, 0),
      () => c.createTexture(8, 8),
      () => c.createRectangleTexture(8, 8),
      () => c.createTexture(8, 8, true),
    ];
    const resources: { dispose(): void }[] = [];
    for (let i = 0; i < factories.length; i++) {
      const make = factories[i];
      const first = make();
      resources.push(make());
      limited(make);
      first.dispose();
      first.dispose();
      resources.push(make());
      limited(make);
    }
    for (let i = 0; i < resources.length; i++) {
      resources[i].dispose();
    }
    for (let i = 0; i < factories.length; i++) {
      factories[i]().dispose();
    }
    check(owned.gl.getError() === owned.gl.NO_ERROR, "byte budgets changed GL state");
  } finally {
    c.dispose();
    check(owned.live.size === 0, "byte budgets retained GPU handles");
    owned.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  const reserve = create({ max2DTextureBytes: 5 });
  try {
    let error: unknown;
    try {
      reserve.backend.createTexture(1, 1);
    } catch (caught) {
      error = caught;
    }
    check(error instanceof Context3DError && error.reason === "limit", "missing AIR mip reserve");
    check(reserve.live.size === 1, "mip reservation failure created a texture handle");
  } finally {
    reserve.backend.dispose();
    check(reserve.live.size === 0, "mip reservation check retained GPU handles");
    reserve.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return { passed: true };
}
