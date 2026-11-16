// What draws the player's WebGL 2: the GPU where Chromium takes it, and
// SwiftShader, Chromium's GPU on the CPU, where it refuses the GPU or finds
// none, as under Xvfb on a server or a CI runner, whose only GL is Mesa's
// llvmpipe, which Chromium's blocklist refuses. Chromium no longer falls back
// to SwiftShader for WebGL unless told to, and without WebGL 2 nothing plays.
import { app } from "electron";

/**
 * Before the app is ready, as Chromium reads its GPU switches as it starts
 * the GPU process. `software` (--software-gl) draws with SwiftShader even
 * where Chromium would take the GPU: for one that gives WebGL but not
 * WebGL 2, or draws wrong.
 */
export function chooseGl(software: boolean): void {
  // Only a fallback: where Chromium takes the GPU, this changes nothing.
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  if (software) {
    app.commandLine.appendSwitch("use-angle", "swiftshader");
    process.stderr.write("swf2es: --software-gl: drawing with SwiftShader, on the CPU\n");
  }

  // The GPU process's state comes after it starts, and again as it restarts or goes. Only the
  // fallback is said: as the app quits, WebGL is "disabled" even where the GPU drew, and where
  // nothing draws the page says so.
  const sayFallback = () => {
    // Chromium's word for WebGL on SwiftShader where the GPU was refused.
    if (app.getGPUFeatureStatus().webgl === "unavailable_software") {
      app.off("gpu-info-update", sayFallback);
      process.stderr.write(
        "swf2es: no GPU Chromium takes here (none, or one its blocklist refuses): " +
          "drawing with SwiftShader, on the CPU\n",
      );
    }
  };
  app.on("gpu-info-update", sayFallback);
}
