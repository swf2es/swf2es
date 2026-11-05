import { readFileSync, writeFileSync } from "node:fs";

import { out } from "./paths.ts";

interface Timing {
  name: string;
  cpu: { median: number };
  gpu: { median: number };
  outputBytesPerFrame: number;
  error: number;
  disjoint: boolean;
}
interface Pair {
  candidate: string;
  scenario: string;
  round: number;
  results: Timing[];
}
const pairs: Pair[] = JSON.parse(readFileSync(`${out}paired.json`, "utf8"));
const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const summaries = [];
for (const scenario of ["static", "rotate", "scale"]) {
  for (const candidate of ["main-4", "coverage-4", "coverage-1"]) {
    const matching = pairs.filter((p) => p.scenario === scenario && p.candidate === candidate);
    if (
      matching.length !== 5 ||
      matching.some((p) => p.results.some((r) => r.error || r.disjoint))
    ) {
      throw new Error("Missing or invalid benchmark rounds");
    }
    summaries.push({
      scenario,
      candidate,
      mainCpuMs: median(matching.map((p) => p.results[0].cpu.median)),
      candidateCpuMs: median(matching.map((p) => p.results[1].cpu.median)),
      mainGpuMs: median(matching.map((p) => p.results[0].gpu.median)),
      candidateGpuMs: median(matching.map((p) => p.results[1].gpu.median)),
      pairedGpuChangePercent: median(
        matching.map((p) => (p.results[1].gpu.median / p.results[0].gpu.median - 1) * 100),
      ),
      gpuRatiosByRound: matching.map((p) => p.results[1].gpu.median / p.results[0].gpu.median),
      outputBytesPerFrame: matching[0].results[1].outputBytesPerFrame,
    });
  }
}
const metadata = {
  main: "370c4985a51723b4dba9fb0fc11f9b9f90702bc5",
  experimentBase: "abf753f7453b4287a427f2804530c72cec858e6b",
  baseline:
    "Render, native and Context3D sources are identical to origin/main. Only experiments/native-edge-aa is added.",
  date: "2026-11-02",
  workload:
    "640 separate opaque rectangles, 1600x1000 framebuffer, hardware WebGL2, no player/VM/game workload",
  method:
    "Five paired rounds. Each pair retains two contexts; 100 warmup frames and 120 measured frames per mode, alternating frame order. GL finish outside CPU measurement; disjoint GPU timer queries. Separate sampled-allocation run includes setup, 20 warmup and 240 measured frames.",
  scope:
    "Convex opaque outlines only. Curves, joined strokes, masks, filters, textures, thin and transparent shapes are not established by this prototype. Its fallback requires MSAA; do not globally lower the player's MSAA based on these results.",
  controls:
    "Shader-only 8x pixels exactly match unchanged main-8 in both fixtures. No production file or local game bundle was changed.",
  memory:
    "256 KiB fixed kernel memory. Geometry payload is 46,080 bytes on main and 179,200 with coverage for 640 rectangles. GPU atlas stride remains 20 bytes per vertex. Scaling rebuilds coverage geometry each frame; the baseline retains its cache.",
  validation:
    "Two Zig unit tests; 2,000 randomized rotated rectangles in both windings with finite vertices, valid indices, consistent triangle winding, fixed memory and preserved buffer ownership. Typecheck and Biome pass for the experiment. Not a full player regression run or production-ready change.",
  next: "Retain boundary/extrusion data and compute the screen-space offset in the vertex shader. Re-test non-uniform scaling, thin paths, corners, overlaps, masks and alpha transforms before integrating. One pixel in local coordinates is not sufficient under changing transforms.",
};
writeFileSync(`${out}summary.json`, JSON.stringify({ metadata, summaries }, null, 2));
const htmlEscape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const image = (name: string) =>
  `data:image/png;base64,${readFileSync(`${out}${name}.png`).toString("base64")}`;
const labels = ["main-8", "main-4", "coverage-4", "coverage-1", "flash-best", "box-reference"];
const pictures = ["", "diagonal-"]
  .map(
    (prefix) =>
      `<section><h2>${prefix ? "Steeper angles" : "Shallow angles"}</h2><div class="grid">${labels.map((name) => `<figure><figcaption>${name}</figcaption><div class="image"><img alt="${htmlEscape(name)}: isolated opaque rectangles" src="${image(prefix + name)}"></div></figure>`).join("")}</div></section>`,
  )
  .join("");
const table = summaries
  .map(
    (r) =>
      `<tr><td>${r.scenario}</td><td>${r.candidate}</td><td>${r.mainCpuMs.toFixed(3)}</td><td>${r.candidateCpuMs.toFixed(3)}</td><td>${r.mainGpuMs.toFixed(3)}</td><td>${r.candidateGpuMs.toFixed(3)}</td><td>${r.pairedGpuChangePercent.toFixed(1)}%</td><td>${r.outputBytesPerFrame.toLocaleString()}</td></tr>`,
  )
  .join("");
const quality = ["", "diagonal-"]
  .map((prefix) => {
    const data: { rows: { name: string; exactBoxEdgeMAE: number; areaErrorPercent: number }[] } =
      JSON.parse(readFileSync(`${out}${prefix}quality.json`, "utf8"));
    return `<h3>${prefix ? "Steeper" : "Shallow"} edges</h3><table><tr><th>Mode</th><th>Edge error vs exact box coverage (0–255)</th><th>Covered area error</th></tr>${data.rows
      .filter((r) => r.name !== "shader-only-8")
      .map(
        (r) =>
          `<tr><td>${r.name}</td><td>${r.exactBoxEdgeMAE.toFixed(3)}</td><td>${r.areaErrorPercent.toFixed(3)}%</td></tr>`,
      )
      .join("")}</table>`;
  })
  .join("");
writeFileSync(
  `${out}report.html`,
  `<!doctype html><meta charset="utf-8"><title>Native edge coverage experiment</title>
<style>body{font:16px system-ui;color:#17212b;background:#f7f7f7;margin:24px;max-width:1400px}p{max-width:1050px;line-height:1.5}table{border-collapse:collapse;background:white}th,td{padding:8px;border:1px solid #ccc;text-align:right}th:first-child,td:first-child{text-align:left}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(512px,1fr));gap:12px}figure{margin:0}figcaption{font-weight:600;padding:8px}.image{width:512px;height:320px;overflow:auto;border:1px solid #bbb;background:white}img{display:block;width:512px;height:320px;max-width:none}.zoom img{width:2048px;height:1280px;image-rendering:pixelated}button{padding:8px 12px;margin:12px 0}pre{white-space:pre-wrap;background:white;padding:16px}h2{margin-top:32px}</style>
<h1>Native edge coverage vs main</h1><p>2026-11-02 · main <code>370c4985</code> · RTX 4060 Laptop GPU, ANGLE/Vulkan · isolated prototype</p>
<p><strong>Result:</strong> cached opaque outlines can look smoother without MSAA. Rebuilding their coverage geometry under scale is a CPU and allocation regression. Keep this out of the player; prototype shader-side extrusion next.</p>
<p>${htmlEscape(metadata.workload)}. ${htmlEscape(metadata.method)}</p>
<h2>Paired timings</h2><p>Times are milliseconds. Each cell is the median of five run medians; the percentage is the median of the five paired GPU ratios. This avoids comparing unrelated GPU clock states, which still affect the absolute times. CPU is measured before gl.finish; these are not end-to-end frame rates.</p>
<table><tr><th>Scenario</th><th>Candidate</th><th>Main CPU</th><th>Candidate CPU</th><th>Main GPU</th><th>Candidate GPU</th><th>Paired GPU change</th><th>New geometry bytes/frame</th></tr>${table}</table>
<h2>Pixels</h2><p>The box reference integrates each original polygon over every pixel independently. Lower error against it is useful evidence for edge coverage; it is not a Flash compatibility claim. AIR high and best produced identical captures for these fixtures. Other Flash quality modes were not tested. Main-8 and shader-only-8 are pixel-identical.</p>
<button onclick="document.body.classList.toggle('zoom')">Toggle 4× pixel zoom</button>${pictures}${quality}
<h2>Memory and scope</h2><p>${htmlEscape(metadata.memory)}</p><p>The separate sampled-JS-allocation pass measured 4.53 MB for main versus 127.79 MB for coverage while scaling, over setup plus 260 frames. This includes collected allocations and does not measure retained heap or total memory; typed-buffer payload is reported separately. Static-pass totals include geometry setup and must not be read as a steady-state allocation improvement.</p>
<p>${htmlEscape(metadata.scope)}</p><p>${htmlEscape(metadata.validation)}</p><p>${htmlEscape(metadata.next)}</p>
<h2>Reproduce</h2><pre>cd &lt;checkout&gt;
node experiments/native-edge-aa/build.ts
flock ~/.cache/swf2es/machine.lock node experiments/native-edge-aa/run.ts validate
flock ~/.cache/swf2es/machine.lock node experiments/native-edge-aa/run.ts paired
flock ~/.cache/swf2es/machine.lock node experiments/native-edge-aa/run.ts allocations
flock ~/.cache/swf2es/machine.lock node experiments/native-edge-aa/reference.ts
flock ~/.cache/swf2es/machine.lock node experiments/native-edge-aa/reference.ts diagonal
flock ~/.cache/swf2es/machine.lock node experiments/native-edge-aa/run.ts capture
flock ~/.cache/swf2es/machine.lock node experiments/native-edge-aa/run.ts capture diagonal
node experiments/native-edge-aa/quality.ts
node experiments/native-edge-aa/quality.ts diagonal
node experiments/native-edge-aa/report.ts</pre>`,
);
console.log(`${out}report.html`);
