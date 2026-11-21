// A prototype of stencil-then-cover for the fills libtess2 is pathologically slow at (#1104,
// "pathological fills"), measured before any of it goes into the renderer. The deck (deck.ts)
// is drawn in headless Chrome two ways, by the same program into the same multisampled target:
//
// - tessellated: libtess2's triangles of the fill (@swf2es/native's Tessellator, as the renderer
//   asks for them), drawn once;
// - covered: (a) a fan of triangles from each contour's first point into the stencil, INVERT on
//   bit 7 (0x80), colour writes off, testing the low seven bits equal to the mask depth (0); then
//   (b) a quad over the fill's box with the paint, testing the stencil equal to 0x80 and clearing
//   bit 7 as it draws, so nothing is left to clear.
//
// The points are the deck's own: its edges are straight, so the renderer's flattening (0.02 px
// chords) gives them as they are. Both images are resolved and compared, pixel by pixel: the
// largest channel difference, and how many pixels differ at all and by more than 2 of 255. A
// third pass over the box after the covered draw paints red wherever any stencil bit is still
// set, which must leave the image as it was.
//
// GPU time: each way drawn `--repeat` times between two TIME_ELAPSED queries
// (EXT_disjoint_timer_query_webgl2) where the context has them, the median of `--runs`; and by
// the wall clock, the same draws between two waits for the GPU (a pixel read), less the wait
// alone. CPU time: libtess2 on the deck, as the renderer calls it (a layer of path commands),
// against building the fans and the box from the same points (the median of 50).
//
//   node tests/player/cover-bench.ts [--gpu] [--decks 10,40,80,160] [--samples 4,16]
//     [--scales 1,2] [--paint solid|gradient|bitmap] [--repeat R] [--runs N] [--json]
//
// --gpu draws on the machine's GPU (Vulkan ANGLE: VK_DRIVER_FILES picks which), SwiftShader
// otherwise; the output names the renderer and the samples the target got (a context's
// MAX_SAMPLES caps them). --scales draws the bench's 800 by 600 stage at each scale: 2 is a
// stage shown at a device pixel ratio of 2.
import { withPage } from "./chrome.ts";
import { DECK_BOX, deckContours } from "./deck.ts";

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const list = (name: string, fallback: string) => value(name, fallback).split(",").map(Number);
const decks = list("decks", "10,40,80,160");
const sampleCounts = list("samples", "4,16");
const scales = list("scales", "1,2");
const paint = ["solid", "gradient", "bitmap"].indexOf(value("paint", "solid"));
const repeat = Number(value("repeat", "10"));
const runs = Number(value("runs", "7"));
const gpu = args.includes("--gpu");
if (paint < 0) {
  console.error("--paint is solid, gradient or bitmap");
  process.exit(2);
}

interface Drawn {
  scale: number;
  /** The samples asked for, and those the target has. */
  asked: number;
  samples: number;
  width: number;
  height: number;
  /** Pixels the tessellated fill changed from the background. */
  covered: number;
  maxDiff: number;
  differing: number;
  over2: number;
  /** Pixels the leftover-stencil pass changed: 0 where cover cleared every bit it set. */
  leftover: number;
  /**
   * On the pixels that differ, with a solid paint: each way's mean and largest distance in red
   * from the fill's coverage of 256 points a pixel, by parity.
   */
  reference: {
    tessellated: number;
    covered: number;
    tessellatedWorst: number;
    coveredWorst: number;
  } | null;
  /** ms a draw, by TIME_ELAPSED (null without the extension) and by the wall clock. */
  tessellatedGpu: number | null;
  coverGpu: number | null;
  fanGpu: number | null;
  tessellatedWall: number;
  coverWall: number;
}

interface DeckResult {
  contours: number;
  points: number;
  /** ms: libtess2's layer call, and building the fans and the box. */
  libtess2: number;
  fans: number;
  tessVertices: number;
  tessTriangles: number;
  fanTriangles: number;
  /** Area in stage pixels: the fans' triangles summed, the box's, and the fill's own. */
  fanArea: number;
  boxArea: number;
  fillArea: number;
  drawn: Drawn[];
}

/** The page's side: set up once, then `coverDeck` for each deck. */
const SETUP = `(async () => {
  const { Tessellator, PATH_MOVE, PATH_LINE } = await import("@swf2es/native/render");
  const tess = new Tessellator();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: true });
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const maxSamples = gl.getParameter(gl.MAX_SAMPLES);
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, \`#version 300 es
    in vec2 a_pos;
    uniform vec2 u_size;
    uniform float u_scale;
    out vec2 v_pos;
    void main() {
      v_pos = a_pos;
      vec2 p = a_pos * u_scale / u_size * 2.0 - 1.0;
      gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
    }\`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, \`#version 300 es
    precision highp float;
    in vec2 v_pos;
    uniform int u_paint;
    uniform vec4 u_color;
    uniform sampler2D u_tex;
    out vec4 o;
    void main() {
      if (u_color.a > 0.0) {
        o = u_color;
      } else if (u_paint == 0) {
        o = vec4(0.2, 0.4, 0.8, 1.0);
      } else if (u_paint == 1) {
        float t = clamp((v_pos.x - ${DECK_BOX[0]}.0) / ${DECK_BOX[1] - DECK_BOX[0]}.0, 0.0, 1.0);
        o = mix(vec4(0.125, 0.25, 0.627, 1.0), vec4(0.878, 0.627, 0.125, 1.0), t);
      } else {
        o = texture(u_tex, v_pos / 32.0);
      }
    }\`));
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const uniform = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform("u_paint"), ${paint});
  // A 16 by 16 checker of 4-pixel squares, smoothed and repeating, as bench.ts --deck's bitmap.
  const texels = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      texels.set((x >> 2) % 2 === (y >> 2) % 2 ? [230, 120, 40, 255] : [40, 90, 160, 255], (y * 16 + x) * 4);
    }
  }
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // A wait for the GPU: a pixel read of a target of its own, which Chrome answers once all is drawn.
  const tiny = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, tiny);
  const tinyColor = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, tinyColor);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, tinyColor);
  const pixel = new Uint8Array(4);
  const finish = () => {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tiny);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  };
  const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
  const elapsed = (draw) => {
    if (!timer) return null;
    const queries = [];
    for (let run = 0; run < ${runs}; run++) {
      const query = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      for (let k = 0; k < ${repeat}; k++) draw();
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      finish();
      // Read once all are done: a query's result comes in a later task (read).
      queries.push(query);
    }
    return queries;
  };
  const read = async (queries) => {
    if (!queries) return null;
    const ns = [];
    for (const query of queries) {
      for (let k = 0; k < 200 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); k++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      if (gl.getParameter(timer.GPU_DISJOINT_EXT)) return null;
      ns.push(gl.getQueryParameter(query, gl.QUERY_RESULT));
      gl.deleteQuery(query);
    }
    return median(ns) / 1e6 / ${repeat};
  };
  const wall = (draw) => {
    const times = [];
    for (let run = 0; run < ${runs}; run++) {
      finish();
      const idle = performance.now();
      finish();
      const waited = performance.now() - idle;
      const begun = performance.now();
      for (let k = 0; k < ${repeat}; k++) draw();
      finish();
      times.push((performance.now() - begun - waited) / ${repeat});
    }
    return Math.max(0, median(times));
  };

  globalThis.coverDeck = async (contours, scales, sampleCounts) => {
    const points = contours.reduce((n, c) => n + c.length / 2, 0);

    // libtess2 as the renderer asks for it: one layer, its contours as path commands.
    const commands = contours.map((c) => {
      const out = [];
      for (let k = 0; k < c.length; k += 2) out.push(k ? PATH_LINE : PATH_MOVE, c[k], c[k + 1]);
      out.push(PATH_LINE, c[0], c[1]);
      return out;
    });
    let begun = performance.now();
    const tessellated = tess.tessellate.layer([commands], [false])[0];
    const libtess2 = performance.now() - begun;
    const tessIndices = Uint32Array.from(
      tessellated.indices,
      (i) => i - (tessellated.indexOffset ?? 0),
    );
    const tessVertices = Float32Array.from(tessellated.vertices);

    // The fans and the box: a contour of n points fans into n - 2 triangles from its first.
    let positions, fanIndices, fanCount, box;
    const build = () => {
      let triangles = 0;
      for (const c of contours) triangles += c.length / 2 - 2;
      positions = new Float32Array(points * 2 + 8);
      fanIndices = new Uint32Array(triangles * 3 + 6);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      let at = 0, i = 0;
      for (const c of contours) {
        const first = at;
        for (let k = 0; k < c.length; k += 2) {
          const x = c[k], y = c[k + 1];
          positions[at * 2] = x;
          positions[at * 2 + 1] = y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (k >= 4) {
            fanIndices[i++] = first;
            fanIndices[i++] = at - 1;
            fanIndices[i++] = at;
          }
          at++;
        }
      }
      positions.set([x0, y0, x1, y0, x1, y1, x0, y1], at * 2);
      fanIndices.set([at, at + 1, at + 2, at, at + 2, at + 3], i);
      fanCount = i;
      box = [x0, y0, x1, y1];
    };
    const fanTimes = [];
    for (let k = 0; k < 50; k++) {
      begun = performance.now();
      build();
      fanTimes.push(performance.now() - begun);
    }

    // Areas in stage pixels: what the fans make the stencil touch, against the box and the fill.
    const area = (vertices, indices) => {
      let sum = 0;
      for (let k = 0; k < indices.length; k += 3) {
        const a = indices[k] * 2, b = indices[k + 1] * 2, c = indices[k + 2] * 2;
        sum += Math.abs((vertices[b] - vertices[a]) * (vertices[c + 1] - vertices[a + 1]) -
          (vertices[c] - vertices[a]) * (vertices[b + 1] - vertices[a + 1])) / 2;
      }
      return sum;
    };

    const vao = (vertices, indices) => {
      const array = gl.createVertexArray();
      gl.bindVertexArray(array);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const elements = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      return { array, buffers: [buffer, elements] };
    };
    const tessVao = vao(tessVertices, tessIndices);
    const fanVao = vao(positions, fanIndices);

    const drawTessellated = () => {
      gl.disable(gl.STENCIL_TEST);
      gl.bindVertexArray(tessVao.array);
      gl.drawElements(gl.TRIANGLES, tessIndices.length, gl.UNSIGNED_INT, 0);
    };
    const drawFans = () => {
      gl.enable(gl.STENCIL_TEST);
      gl.bindVertexArray(fanVao.array);
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(gl.EQUAL, 0, 0x7f);
      gl.stencilMask(0x80);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.drawElements(gl.TRIANGLES, fanCount, gl.UNSIGNED_INT, 0);
      gl.colorMask(true, true, true, true);
    };
    const drawCoverQuad = () => {
      gl.stencilFunc(gl.EQUAL, 0x80, 0xff);
      gl.stencilMask(0x80);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_INT, fanCount * 4);
      gl.stencilMask(0xff);
    };
    const drawCovered = () => {
      drawFans();
      drawCoverQuad();
    };

    const drawn = [];
    for (const scale of scales) {
      const width = 800 * scale, height = 600 * scale;
      gl.uniform2f(uniform("u_size"), width, height);
      gl.uniform1f(uniform("u_scale"), scale);
      for (const asked of sampleCounts) {
        const samples = Math.min(asked, maxSamples);
        const target = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, target);
        const color = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, color);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
        const stencil = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
        const resolved = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, resolved);
        const resolvedColor = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, resolvedColor);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, resolvedColor);

        const begin = () => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target);
          gl.viewport(0, 0, width, height);
          gl.clearColor(0.94, 0.94, 0.94, 1);
          gl.clearStencil(0);
          gl.stencilMask(0xff);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        };
        const image = () => {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved);
          gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resolved);
          const out = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
          return out;
        };

        begin();
        const background = image();
        begin();
        drawTessellated();
        const a = image();
        begin();
        drawCovered();
        const b = image();
        // Red wherever a stencil bit is still set after the cover.
        gl.bindFramebuffer(gl.FRAMEBUFFER, target);
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.uniform4f(uniform("u_color"), 1, 0, 0, 1);
        gl.bindVertexArray(fanVao.array);
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_INT, fanCount * 4);
        gl.uniform4f(uniform("u_color"), 0, 0, 0, 0);
        gl.disable(gl.STENCIL_TEST);
        const c = image();

        let covered = 0, maxDiff = 0, differing = 0, over2 = 0, leftover = 0;
        const apart = [];
        for (let p = 0; p < a.length; p += 4) {
          let most = 0, changed = false, left = false;
          for (let k = 0; k < 4; k++) {
            most = Math.max(most, Math.abs(a[p + k] - b[p + k]));
            changed ||= a[p + k] !== background[p + k];
            left ||= b[p + k] !== c[p + k];
          }
          if (changed) covered++;
          if (left) leftover++;
          if (most > 0) {
            differing++;
            apart.push(p >> 2);
          }
          if (most > 2) over2++;
          maxDiff = Math.max(maxDiff, most);
        }

        // Where the two differ, which is nearer the fill: its coverage of 16 by 16 points a pixel
        // by parity in doubles, as the red a solid fill over the background would take.
        let reference = null;
        if (${paint} === 0 && apart.length > 0) {
          const rows = Array.from({ length: height }, () => []);
          for (const contour of contours) {
            for (let k = 0; k < contour.length; k += 2) {
              const x0 = contour[k] * scale, y0 = contour[k + 1] * scale;
              const j = (k + 2) % contour.length;
              const x1 = contour[j] * scale, y1 = contour[j + 1] * scale;
              const top = Math.max(0, Math.floor(Math.min(y0, y1)));
              const bottom = Math.min(height - 1, Math.floor(Math.max(y0, y1)));
              for (let row = top; row <= bottom; row++) rows[row].push(x0, y0, x1, y1);
            }
          }
          let tessError = 0, coverError = 0, tessWorst = 0, coverWorst = 0;
          for (const at of apart) {
            const px = at % width, row = height - 1 - Math.floor(at / width);
            const edges = rows[row];
            let inside = 0;
            for (let sy = 0; sy < 16; sy++) {
              const y = row + (sy + 0.5) / 16;
              for (let sx = 0; sx < 16; sx++) {
                const x = px + (sx + 0.5) / 16;
                let odd = false;
                for (let e = 0; e < edges.length; e += 4) {
                  const ey0 = edges[e + 1], ey1 = edges[e + 3];
                  if ((ey0 <= y) !== (ey1 <= y)) {
                    const ex = edges[e] + ((y - ey0) / (ey1 - ey0)) * (edges[e + 2] - edges[e]);
                    if (ex > x) odd = !odd;
                  }
                }
                if (odd) inside++;
              }
            }
            const share = inside / 256;
            const red = background[at * 4] * (1 - share) + 51 * share;
            const tessOff = Math.abs(a[at * 4] - red), coverOff = Math.abs(b[at * 4] - red);
            tessError += tessOff;
            coverError += coverOff;
            tessWorst = Math.max(tessWorst, tessOff);
            coverWorst = Math.max(coverWorst, coverOff);
          }
          reference = {
            tessellated: tessError / apart.length,
            covered: coverError / apart.length,
            tessellatedWorst: tessWorst,
            coveredWorst: coverWorst,
          };
        }

        // The GPU's clock brought up before anything is timed: a few hundred ms of cover.
        begin();
        for (const until = performance.now() + 300; performance.now() < until; ) {
          drawCovered();
          finish();
        }

        begin();
        const tessQueries = elapsed(drawTessellated);
        const tessellatedGpu = await read(tessQueries);
        begin();
        const coverQueries = elapsed(drawCovered);
        const coverGpu = await read(coverQueries);
        // The fans alone leave bit 7 set; each repeat inverts it back or on, which costs the same.
        begin();
        const fanQueries = elapsed(drawFans);
        const fanGpu = await read(fanQueries);
        begin();
        const tessellatedWall = wall(drawTessellated);
        begin();
        const coverWall = wall(drawCovered);

        gl.deleteFramebuffer(target);
        gl.deleteFramebuffer(resolved);
        for (const r of [color, stencil, resolvedColor]) gl.deleteRenderbuffer(r);
        drawn.push({
          scale, asked, samples, width, height, covered, maxDiff, differing, over2, leftover,
          reference, tessellatedGpu, coverGpu, fanGpu, tessellatedWall, coverWall,
        });
      }
    }

    for (const v of [tessVao, fanVao]) {
      gl.deleteVertexArray(v.array);
      for (const b of v.buffers) gl.deleteBuffer(b);
    }

    const fanIndicesOnly = fanIndices.subarray(0, fanCount);
    return {
      contours: contours.length,
      points,
      libtess2,
      fans: median(fanTimes),
      tessVertices: tessVertices.length / 2,
      tessTriangles: tessIndices.length / 3,
      fanTriangles: fanCount / 3,
      fanArea: area(positions, fanIndicesOnly),
      boxArea: (box[2] - box[0]) * (box[3] - box[1]),
      fillArea: area(tessVertices, tessIndices),
      drawn,
    };
  };
  return { renderer, timer: !!timer, maxSamples };
})()`;

const ms = (v: number | null) => (v === null ? "   n/a" : v.toFixed(3).padStart(6));
const results: DeckResult[] = [];
const setup = await withPage(
  "runSwf",
  async (evaluate) => {
    const ready = await evaluate<{ renderer: string; timer: boolean; maxSamples: number }>(SETUP);
    if (ready.exception || !ready.value) {
      throw new Error(ready.exception ?? "no setup");
    }

    if (!args.includes("--json")) {
      console.log(
        `${ready.value.renderer}; MAX_SAMPLES ${ready.value.maxSamples}; TIME_ELAPSED ${ready.value.timer ? "available" : "not available"}; ${["solid", "gradient", "bitmap"][paint]} paint; ${repeat} draws a run, median of ${runs}`,
      );
    }

    for (const count of decks) {
      const { value: deck, exception } = await evaluate<DeckResult>(
        `coverDeck(${JSON.stringify(deckContours(count))}, ${JSON.stringify(scales)}, ${JSON.stringify(sampleCounts)})`,
      );
      if (exception || !deck) {
        throw new Error(exception ?? "no result");
      }

      results.push(deck);
      if (args.includes("--json")) {
        continue;
      }

      console.log(
        `deck of ${deck.contours} (${deck.points} points): libtess2 ${deck.libtess2.toFixed(1)} ms, ${deck.tessVertices} vertices, ${deck.tessTriangles} triangles; fans and box ${deck.fans.toFixed(3)} ms, ${deck.fanTriangles} triangles; fans cover ${Math.round(deck.fanArea)} px, ${(deck.fanArea / deck.boxArea).toFixed(1)}x the box (${Math.round(deck.boxArea)} px), ${(deck.fanArea / deck.fillArea).toFixed(1)}x the fill (${Math.round(deck.fillArea)} px)`,
      );
      for (const d of deck.drawn) {
        console.log(
          `  ${d.width}x${d.height} ${String(d.samples).padStart(2)} samples${d.samples < d.asked ? ` (of ${d.asked})` : ""}: pixels max diff ${d.maxDiff}, ${d.differing} differ, ${d.over2} by more than 2, of ${d.covered} filled, ${d.leftover} left in the stencil; GPU ms a draw: tessellated ${ms(d.tessellatedGpu)}  covered ${ms(d.coverGpu)} (fans ${ms(d.fanGpu)}); wall: tessellated ${ms(d.tessellatedWall)}  covered ${ms(d.coverWall)}`,
        );
        if (d.reference) {
          const r = d.reference;
          console.log(
            `    where they differ, red off the 256-point coverage: tessellated mean ${r.tessellated.toFixed(1)} (worst ${Math.round(r.tessellatedWorst)}), covered mean ${r.covered.toFixed(1)} (worst ${Math.round(r.coveredWorst)})`,
          );
        }
      }
    }

    return ready.value;
  },
  gpu,
  { timeout: 900_000 },
);

if (args.includes("--json")) {
  console.log(JSON.stringify({ ...setup, paint: ["solid", "gradient", "bitmap"][paint], results }));
}
