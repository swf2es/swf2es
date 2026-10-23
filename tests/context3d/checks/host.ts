import { stage3DCanvasHost } from "@swf2es/player-hosts/stage3d";

import { check, create, rejects } from "./context.ts";

export function canvasHost(): { passed: boolean } {
  const parent = document.createElement("div");
  const surfaces: ReturnType<typeof create>[] = [];
  let destroyed = 0;
  const host = stage3DCanvasHost(parent, () => {
    const surface = create();
    surfaces.push(surface);
    return {
      canvas: surface.canvas,
      context: surface.backend,
      destroy: () => {
        check(
          surface.backend.disposed && surface.live.size === 0,
          "surface destroyed before resources",
        );
        destroyed++;
      },
    };
  });
  let lost = 0;
  let restored = 0;
  const lifecycle = {
    lost: () => lost++,
    restored: () => restored++,
  };

  try {
    const context = host.create(2, lifecycle);
    context.configure(64, 64);
    host.place(2, -7, 11, false);
    const surface = surfaces[0];
    const style = surface.canvas.style;
    check(surface.canvas.parentElement === parent, "canvas host did not attach the surface");
    check(
      style.position === "absolute" &&
        style.zIndex === "2" &&
        style.left === "-7px" &&
        style.top === "11px" &&
        style.visibility === "hidden",
      "canvas host lost placement",
    );
    rejects(() => host.create(2, lifecycle));
    check(surfaces.length === 1, "duplicate slot allocated a surface");
    const event = new Event("webglcontextlost", { cancelable: true });
    surface.canvas.dispatchEvent(event);
    surface.canvas.dispatchEvent(new Event("webglcontextrestored"));
    check(event.defaultPrevented && lost === 1 && restored === 1, "loss callbacks were not wired");
    context.dispose();
    host.remove(2);
    host.remove(2);
    check(Number(destroyed) === 1, "surface destroy was repeated or omitted");
    check(!surface.canvas.parentElement && surface.live.size === 0, "surface not released");
    surface.canvas.dispatchEvent(new Event("webglcontextlost"));
    surface.canvas.dispatchEvent(new Event("webglcontextrestored"));
    check(lost === 1 && restored === 1, "removed surface kept its listeners");

    const append = parent.append;
    parent.append = () => {
      throw new Error("injected canvas attachment failure");
    };
    try {
      rejects(() => host.create(1, lifecycle));
    } finally {
      parent.append = append;
    }
    const failed = surfaces[1];
    check(Number(destroyed) === 2, "failed attachment omitted surface destroy");
    check(failed.backend.disposed && failed.live.size === 0, "failed attachment leaked handles");
    failed.canvas.dispatchEvent(new Event("webglcontextlost"));
    check(lost === 1, "failed attachment leaked listeners");
    const retry = host.create(1, lifecycle);
    retry.dispose();
    host.remove(1);
    check(Number(destroyed) === 3, "retry omitted surface destroy");
    check(parent.children.length === 0, "canvas host retained retired surfaces");
  } finally {
    for (let i = 0; i < surfaces.length; i++) {
      surfaces[i].backend.dispose();
      surfaces[i].gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    host.remove(1);
    host.remove(2);
  }

  return { passed: true };
}
