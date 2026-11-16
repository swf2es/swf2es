// What draws the player's WebGL 2: the GPU where Chromium takes it. Where it
// refuses the GPU or finds none, as under Xvfb on a server or a CI runner,
// whose only GL is Mesa's llvmpipe, which Chromium's blocklist refuses, there
// is no WebGL 2 and nothing plays unless the user asks for SwiftShader,
// Chromium's GPU on the CPU, with --software-gl. It is not a silent fallback:
// Chromium calls SwiftShader unsafe for untrusted content, and on Linux the
// GPU process it runs in has no sandbox (docs/architecture/desktop.md).
import { app } from "electron";

/**
 * Before the app is ready, as Chromium reads its GPU switches as it starts
 * the GPU process. `software` (--software-gl) draws with SwiftShader: where
 * Chromium takes no GPU, and where it takes one that gives WebGL but not
 * WebGL 2, or draws wrong.
 */
export function chooseGl(software: boolean): void {
  if (software) {
    app.commandLine.appendSwitch("enable-unsafe-swiftshader");
    app.commandLine.appendSwitch("use-angle", "swiftshader");
    process.stderr.write("swf2es: --software-gl: drawing with SwiftShader, on the CPU\n");
    return;
  }

  // Read once, from the GPU process's first report (about 200 ms in): before it WebGL reads
  // "disabled_off" even where the GPU will draw, and later reports include the quit's, which
  // reads disabled too. Electron 44 reports no "webgl2" status; WebGL's is "disabled_off" where
  // the GPU was refused with no fallback ("unavailable_software" is SwiftShader's, which draws).
  app.once("gpu-info-update", () => {
    const webgl = app.getGPUFeatureStatus().webgl;
    if (webgl === "disabled_off" || webgl === "unavailable_off") {
      process.stderr.write(
        "swf2es: no GPU Chromium takes here (none, or one its blocklist refuses), so no " +
          "WebGL 2 and nothing draws; --software-gl draws with SwiftShader, on the CPU\n",
      );
    }
  });
}
