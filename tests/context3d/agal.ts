// Deliberately small AGAL v1 slice for the opt-in Context3D probe.
// Format: https://github.com/adobe/glsl2agal/blob/master/agalassembler/agal.h
export type ProgramType = "vertex" | "fragment";

export interface SamplerSource {
  index: number;
  linear: boolean;
  repeat: boolean;
  mip: number;
  cube: boolean;
}

export interface ShaderSource {
  source: string;
  attributes: number[];
  constants: number[];
  samplers: SamplerSource[];
}

const SUPPORTED = new Set([
  0, 1, 2, 3, 4, 6, 7, 8, 9, 0x0a, 0x0b, 0x0e, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
  0x27, 0x28, 0x29, 0x2a,
]);
const UNARY = new Set([0, 8, 9, 0x0a, 0x0e, 0x14, 0x15, 0x16, 0x27]);

export function translate(bytes: Uint8Array, stage: ProgramType): ShaderSource {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 31 ||
    (bytes.length - 7) % 24 !== 0 ||
    (bytes.length - 7) / 24 > 200 ||
    bytes[0] !== 0xa0 ||
    data.getUint32(1, true) !== 1 ||
    bytes[5] !== 0xa1 ||
    bytes[6] !== (stage === "vertex" ? 0 : 1)
  ) {
    throw new Error("Context3D experiment requires an AGAL v1 program");
  }

  const names = new Map<string, string>();
  const attributes = new Set<number>();
  const constants = new Set<number>();
  const samplers = new Map<number, SamplerSource>();
  const lines: string[] = [];
  const components = "xyzw";
  let output = false;
  const register = (type: number, index: number, write: boolean): string => {
    let name: string;
    let declaration: string;
    switch (type) {
      case 0:
        if (stage !== "vertex" || write || index >= 8) {
          throw new Error("Invalid AGAL attribute");
        }
        name = `va${index}`;
        declaration = `layout(location = ${index}) in vec4 ${name};`;
        attributes.add(index);
        break;
      case 1:
        if (write || index >= (stage === "vertex" ? 128 : 28)) {
          throw new Error("Invalid AGAL constant");
        }
        name = `${stage === "vertex" ? "vc" : "fc"}${index}`;
        declaration = `uniform vec4 ${name};`;
        constants.add(index);
        break;
      case 2:
        if (index >= 8) {
          throw new Error("Invalid AGAL temporary");
        }
        name = `t${index}`;
        declaration = `vec4 ${name};`;
        break;
      case 3:
        if (!write || index !== 0) {
          throw new Error("Invalid AGAL output");
        }
        output = true;
        return "result";
      case 4:
        if (index >= 8 || write !== (stage === "vertex")) {
          throw new Error("Invalid AGAL varying");
        }
        name = `v${index}`;
        declaration = `${stage === "vertex" ? "out" : "in"} vec4 ${name};`;
        break;
      default:
        throw new Error("Unsupported AGAL register");
    }

    names.set(name, declaration);
    return name;
  };

  const source = (offset: number, row = 0): string => {
    const low = data.getUint32(offset, true);
    const high = data.getUint32(offset + 4, true);
    if (high >>> 8 || ((low >>> 16) & 255) !== 0) {
      throw new Error("Unsupported AGAL source encoding");
    }

    const name = register(high & 255, (low & 65535) + row, false);
    const swizzle = low >>> 24;
    let lanes = "";
    for (let c = 0; c < 4; c++) {
      lanes += components[(swizzle >>> (c * 2)) & 3];
    }

    return `${name}.${lanes}`;
  };

  for (let offset = 7; offset < bytes.length; offset += 24) {
    const opcode = data.getUint32(offset, true);
    // Unsupported instructions may have no destination or a sampler operand;
    // do not misreport those layouts as malformed arithmetic registers.
    if (!SUPPORTED.has(opcode)) {
      throw new Error("Unsupported AGAL opcode");
    }

    const dest = data.getUint32(offset + 4, true);
    const unary = UNARY.has(opcode);
    if (unary && (data.getUint32(offset + 16, true) || data.getUint32(offset + 20, true))) {
      throw new Error("Nonempty unused AGAL source");
    }

    if (opcode === 0x27) {
      const operand = data.getUint32(offset + 8, true);
      const type = data.getUint32(offset + 12, true);
      const swizzle = operand >>> 24;
      if (
        stage !== "fragment" ||
        dest !== 0 ||
        (type !== 2 && type !== 4) ||
        swizzle !== (swizzle & 3) * 0x55
      ) {
        throw new Error("Invalid AGAL discard");
      }

      lines.push(`if (${source(offset + 8)}.x < 0.0) { discard; }`);
      continue;
    }

    const mask = (dest >>> 16) & 255;
    if (mask === 0 || mask > 15) {
      throw new Error("Invalid AGAL write mask");
    }

    const target = register(dest >>> 24, dest & 65535, true);
    const a = source(offset + 8);
    const b = unary || opcode === 0x28 ? "" : source(offset + 16);

    // AIR differs for overlaps that shuffle written lanes. Replicating the
    // destination lane for a scalar write is safe; unused lanes do not matter.
    if (opcode === 9 || opcode === 0x0b) {
      for (let operand = offset + 8; operand <= offset + (unary ? 8 : 16); operand += 8) {
        const low = data.getUint32(operand, true);
        if (data.getUint32(operand + 4, true) === dest >>> 24 && (low & 65535) === (dest & 65535)) {
          for (let lane = 0; lane < 4; lane++) {
            if (mask & (1 << lane) && ((low >>> (24 + lane * 2)) & 3) !== lane) {
              throw new Error("Unsupported AGAL swizzled root/power overlap");
            }
          }
        }
      }
    }

    let expression: string;
    switch (opcode) {
      case 0:
        expression = a;
        break;
      case 1:
        expression = `(${a} + ${b})`;
        break;
      case 2:
        expression = `(${a} - ${b})`;
        break;
      case 3:
        expression = `(${a} * ${b})`;
        break;
      case 4:
        expression = `(${a} / ${b})`;
        break;
      case 6:
        expression = `min(${a}, ${b})`;
        break;
      case 7:
        expression = `max(${a}, ${b})`;
        break;
      case 8:
        expression = `fract(${a})`;
        break;
      case 9:
        expression = `sqrt(${a})`;
        break;
      case 0x0a:
        expression = `inversesqrt(${a})`;
        break;
      case 0x0b:
        expression = `pow(${a}, ${b})`;
        break;
      case 0x0e:
      case 0x11:
        if (mask !== 7) {
          throw new Error("Unsupported AGAL vector write mask");
        }

        expression = opcode === 0x0e ? `normalize(${a}.xyz)` : `cross(${a}.xyz, ${b}.xyz)`;
        break;
      case 0x12:
        expression = `vec4(dot(${a}.xyz, ${b}.xyz))`;
        break;
      case 0x13:
        expression = `vec4(dot(${a}, ${b}))`;
        break;
      case 0x14:
        expression = `abs(${a})`;
        break;
      case 0x15:
        expression = `(-${a})`;
        break;
      case 0x16:
        expression = `clamp(${a}, 0.0, 1.0)`;
        break;
      case 0x17:
      case 0x18:
      case 0x19: {
        const rows = opcode === 0x18 ? 4 : 3;
        const dimensions = opcode === 0x17 ? ".xyz" : "";
        const matrixType = data.getUint32(offset + 20, true);
        if (
          (rows === 3 && (mask & 8 || (matrixType === 2 && mask !== 7))) ||
          (matrixType !== 1 && matrixType !== 2) ||
          data.getUint32(offset + 16, true) >>> 24 !== 0xe4
        ) {
          throw new Error("Unsupported AGAL matrix operand or write mask");
        }

        const dots: string[] = [];
        for (let row = 0; row < rows; row++) {
          dots.push(`dot(${a}${dimensions}, ${source(offset + 16, row)}${dimensions})`);
        }
        expression = `vec${rows}(${dots.join(", ")})`;
        break;
      }
      case 0x28: {
        const low = data.getUint32(offset + 16, true);
        const high = data.getUint32(offset + 20, true);
        // This slice has no LOD bias or sampler overrides.
        const mip = (high >>> 24) & 15;
        if (stage !== "fragment" || low >= 8 || (high & ~0x13101000) !== 5 || mip > 2) {
          throw new Error("Unsupported AGAL sampler encoding");
        }

        const cube = (high & 0x1000) !== 0;
        const linear = (high & 0x10000000) !== 0;
        const repeat = (high & 0x00100000) !== 0;
        const previous = samplers.get(low);
        if (
          previous &&
          (previous.linear !== linear ||
            previous.repeat !== repeat ||
            previous.mip !== mip ||
            previous.cube !== cube)
        ) {
          throw new Error("Conflicting AGAL sampler states");
        }

        samplers.set(low, { index: low, linear, repeat, mip, cube });
        names.set(`fs${low}`, `uniform ${cube ? "samplerCube" : "sampler2D"} fs${low};`);
        expression = `texture(fs${low}, ${a}.${cube ? "xyz" : "xy"})`;
        break;
      }
      case 0x29:
        if (stage !== "vertex") {
          throw new Error("Unverified AGAL fragment comparison");
        }

        expression = `vec4(greaterThanEqual(${a}, ${b}))`;
        break;
      case 0x2a:
        if (stage !== "vertex") {
          throw new Error("Unverified AGAL fragment comparison");
        }

        expression = `vec4(lessThan(${a}, ${b}))`;
        break;
      default:
        throw new Error("Unsupported AGAL opcode");
    }

    let lanes = "";
    for (let c = 0; c < 4; c++) {
      if (mask & (1 << c)) {
        lanes += components[c];
      }
    }

    // One vector assignment evaluates every source before changing any lane,
    // including overlapping temporary registers in matrix operations.
    lines.push(`${target}.${lanes} = ${expression}.${lanes};`);
  }

  if (!output) {
    throw new Error("AGAL program does not write its output");
  }

  const declarations = [...names.values()].join("\n");
  const finish =
    stage === "vertex"
      ? "gl_Position = vec4(result.xy, result.z * 2.0 - result.w, result.w);"
      : "color = result;";
  return {
    source: `#version 300 es
precision highp float;
${declarations}
${stage === "fragment" ? "out vec4 color;" : ""}
void main() {
  vec4 result = vec4(0.0);
  ${lines.join("\n  ")}
  ${finish}
}`,
    attributes: [...attributes],
    constants: [...constants],
    samplers: [...samplers.values()],
  };
}
