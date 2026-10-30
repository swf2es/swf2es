// Makes the ATF fixtures from PNGs drawn here: four coloured quadrants
// (red, green, blue, yellow from the top left), the same with alpha rising
// to the right, a gradient, and a cube map of six flat colours. Adobe's
// png2atf, from the AIR SDK's atftools (`PNG2ATF` names it; under Wine
// where it is png2atf.exe), encodes each as the fixture's name says:
//
//   node tests/context3d/atf/make.ts
//
// The .atf files are committed, so tests need neither png2atf nor Wine.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const here = fileURLToPath(new URL(".", import.meta.url));
type Pixel = [number, number, number, number];

function png(
  width: number,
  height: number,
  alpha: boolean,
  pixel: (x: number, y: number) => Pixel,
) {
  const channels = alpha ? 4 : 3;
  const raw = new Uint8Array((width * channels + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw.set(pixel(x, y).slice(0, channels), y * (width * channels + 1) + 1 + x * channels);
    }
  }

  const chunk = (type: string, body: Uint8Array) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    out.set(body, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const QUADRANTS: Pixel[] = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
];
const quadrant = (x: number, y: number, size: number) =>
  QUADRANTS[(x * 2 >= size ? 1 : 0) + (y * 2 >= size ? 2 : 0)];
const FACES: Pixel[] = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 0, 255],
  [0, 255, 255, 255],
  [255, 0, 255, 255],
];

const work = mkdtempSync(join(tmpdir(), "swf2es-atf-"));
const tool =
  process.env.PNG2ATF ?? join(process.env.HOME ?? "", "Bin/sdk-win/atftools/png2atf.exe");
const png2atf = (args: string[]) =>
  tool.endsWith(".exe") && process.platform !== "win32"
    ? execFileSync("wine", [tool, "-s", ...args], { cwd: work, stdio: "ignore" })
    : execFileSync(tool, ["-s", ...args], { cwd: work, stdio: "ignore" });

try {
  writeFileSync(
    join(work, "quads.png"),
    png(64, 64, false, (x, y) => quadrant(x, y, 64)),
  );
  writeFileSync(
    join(work, "alpha.png"),
    png(32, 32, true, (x, y) => {
      const [r, g, b] = quadrant(x, y, 32);
      return [r, g, b, (x * 8) & 255];
    }),
  );
  writeFileSync(
    join(work, "grad.png"),
    png(64, 32, false, (x, y) => [x * 4, y * 8, ((x + y) * 2) & 255, 255]),
  );
  for (let face = 0; face < 6; face++) {
    writeFileSync(
      join(work, `cube${face}.png`),
      png(16, 16, false, () => FACES[face]),
    );
  }

  const fixtures: [string, string[]][] = [
    // RGB888 and RGBA8888, lossless.
    ["rgb", ["-q", "0", "-i", "quads.png"]],
    ["rgba", ["-q", "0", "-i", "alpha.png"]],
    ["rgb-cube", ["-q", "0", "-m", "-i", "cube0.png"]],
    // Block compressed: Compressed and CompressedAlpha (JPEG XR and LZMA), and raw.
    ["compressed", ["-c", "-r", "-i", "quads.png"]],
    ["raw", ["-c", "-i", "quads.png"]],
    ["compressed-alpha", ["-c", "-r", "-i", "alpha.png"]],
    ["raw-alpha", ["-c", "-i", "alpha.png"]],
    ["compressed-cube", ["-c", "-r", "-m", "-i", "cube0.png"]],
    ["compressed-wide", ["-c", "-r", "-i", "grad.png"]],
    // Only the levels 0 to 2, the others empty.
    ["compressed-range", ["-c", "-r", "-n", "0,2", "-i", "quads.png"]],
  ];
  for (const [name, args] of fixtures) {
    png2atf([...args, "-o", `${name}.atf`]);
    copyFileSync(join(work, `${name}.atf`), join(here, `${name}.atf`));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
