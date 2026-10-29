// Deliberately small AGAL v1 slice for the opt-in Context3D probe.
// Format: https://github.com/adobe/glsl2agal/blob/master/agalassembler/agal.h
import { SamplerBiasError } from "./backend.js";
import { Context3DError } from "./errors.js";

export type ProgramType = "vertex" | "fragment";

export interface SamplerSource {
  index: number;
  filter: number;
  repeat: boolean;
  mip: number;
  cube: boolean;
  ignore: boolean;
  bias: number;
}

export interface ShaderSource {
  source: string;
  /** Written lanes for vertex programs, read lanes for fragment programs. */
  varyings: Uint8Array;
  attributes: number[];
  constants: number[];
  indirect: boolean;
  samplers: SamplerSource[];
}

const SUPPORTED = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
  0x15, 0x16, 0x17, 0x18, 0x19, 0x27, 0x28, 0x29, 0x2a, 0x2c,
]);
const UNARY = new Set([0, 5, 8, 9, 0x0a, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x14, 0x15, 0x16, 0x27]);

export function translate(bytes: Uint8Array, stage: ProgramType): ShaderSource {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 31 || (bytes.length - 7) % 24 !== 0) {
    throw new Context3DError("agalLength", "Invalid AGAL program length");
  }
  if ((bytes.length - 7) / 24 > 200) {
    throw new Context3DError("agalTokens", "Too many AGAL instructions");
  }
  if (bytes[0] !== 0xa0) {
    throw new Context3DError("agalMagic", "Invalid AGAL magic byte");
  }
  if (data.getUint32(1, true) !== 1) {
    throw new Context3DError("agalVersion", "Context3D experiment requires an AGAL v1 program");
  }
  if (bytes[5] !== 0xa1) {
    throw new Context3DError("agalStageMarker", "Invalid AGAL stage marker");
  }
  if (bytes[6] > 1) {
    throw new Context3DError("agalStage", "Invalid AGAL shader type");
  }
  if (bytes[6] !== (stage === "vertex" ? 0 : 1)) {
    throw new Context3DError(
      stage === "vertex" ? "agalVertexStage" : "agalFragmentStage",
      "Invalid AGAL shader type",
    );
  }

  // Direct-only shaders keep their sparse uniform uploads. An indirect shader
  // shares one bank for direct and indexed reads, without duplicate uniforms.
  let indirect = false;
  for (let offset = 7; offset < bytes.length; offset += 24) {
    const opcode = data.getUint32(offset, true);
    if (
      data.getUint32(offset + 12, true) >>> 31 ||
      (!UNARY.has(opcode) && opcode !== 0x28 && data.getUint32(offset + 20, true) >>> 31)
    ) {
      indirect = true;
    }
  }

  const names = new Map<string, string>();
  const attributes = new Set<number>();
  const constants = new Set<number>();
  const samplers = new Map<number, SamplerSource>();
  const lines: string[] = [];
  const components = "xyzw";
  let output = 0;
  const temporaries = new Uint8Array(8);
  const varyings = new Uint8Array(8);
  const readTemporary = (index: number, mask: number): void => {
    if (!temporaries[index]) {
      throw new Context3DError("agalTemporaryRead", "AGAL temporary read before writing");
    }
    if ((temporaries[index] & mask) !== mask) {
      throw new Context3DError(
        "agalTemporaryComponent",
        "AGAL temporary component read before writing",
      );
    }
  };
  const register = (type: number, index: number, write: boolean): string => {
    let name: string;
    let declaration: string;
    switch (type) {
      case 0:
        if (write || stage !== "vertex" || index >= 8) {
          const reason = write
            ? "agalAttributeWrite"
            : stage !== "vertex"
              ? "agalAttributeStage"
              : "agalAttributeIndex";
          throw new Context3DError(reason, "Invalid AGAL attribute");
        }
        name = `va${index}`;
        declaration = `layout(location = ${index}) in vec4 ${name};`;
        attributes.add(index);
        break;
      case 1:
        if (write || index >= (stage === "vertex" ? 128 : 28)) {
          throw new Context3DError(
            write ? "agalConstantWrite" : "agalConstantIndex",
            "Invalid AGAL constant",
          );
        }

        if (indirect && stage === "vertex") {
          names.set("vc", "uniform vec4 vc[128];");
          return `vc[${index}]`;
        }

        name = `${stage === "vertex" ? "vc" : "fc"}${index}`;
        declaration = `uniform vec4 ${name};`;
        constants.add(index);
        break;
      case 2:
        if (index >= 8) {
          throw new Context3DError("agalTemporaryIndex", "Invalid AGAL temporary");
        }
        name = `t${index}`;
        declaration = `vec4 ${name};`;
        break;
      case 3:
        if (!write || index !== 0) {
          throw new Context3DError(
            write ? "agalOutputIndex" : "agalOutputRead",
            "Invalid AGAL output",
          );
        }
        return "result";
      case 4:
        if (index >= 8 || write !== (stage === "vertex")) {
          throw new Context3DError(
            index >= 8 ? "agalVaryingIndex" : write ? "agalVaryingWrite" : "agalVaryingRead",
            "Invalid AGAL varying",
          );
        }
        name = `v${index}`;
        declaration = `${stage === "vertex" ? "out" : "in"} vec4 ${name};`;
        break;
      default:
        throw new Context3DError("agalRegister", "Unsupported AGAL register");
    }

    names.set(name, declaration);
    return name;
  };

  const source = (offset: number, row = 0): string => {
    const low = data.getUint32(offset, true);
    const high = data.getUint32(offset + 4, true);
    let name: string;
    if (high >>> 31) {
      const type = (high >>> 8) & 255;
      const component = (high >>> 16) & 255;
      const add = (low >>> 16) & 255;
      if (
        stage !== "vertex" ||
        high >>> 24 !== 128 ||
        (high & 255) !== 1 ||
        type > 2 ||
        component > 3 ||
        add >= 128
      ) {
        throw new Context3DError("agalIndirect", "Unsupported AGAL indirect constant");
      }

      const index = register(type, low & 65535, false);
      if (type === 2) {
        readTemporary(low & 65535, 1 << component);
      }
      names.set("vc", "uniform vec4 vc[128];");
      name = `readConstant(${index}.${components[component]}, ${add + row}.0)`;
    } else {
      if (high >>> 8 || ((low >>> 16) & 255) !== 0) {
        throw new Context3DError("agalSourceEncoding", "Unsupported AGAL source encoding");
      }

      name = register(high & 255, (low & 65535) + row, false);
    }

    const swizzle = low >>> 24;
    let lanes = "";
    let readMask = 0;
    for (let c = 0; c < 4; c++) {
      const lane = (swizzle >>> (c * 2)) & 3;
      lanes += components[lane];
      readMask |= 1 << lane;
    }
    if (!(high >>> 31)) {
      const type = high & 255;
      const index = (low & 65535) + row;
      if (type === 2) {
        readTemporary(index, readMask);
      } else if (type === 4) {
        varyings[index] |= readMask;
      }
    }

    return `${name}.${lanes}`;
  };

  for (let offset = 7; offset < bytes.length; offset += 24) {
    const opcode = data.getUint32(offset, true);
    // Unsupported instructions may have no destination or a sampler operand;
    // do not misreport those layouts as malformed arithmetic registers.
    if (!SUPPORTED.has(opcode)) {
      throw new Context3DError("agalOpcode", "Unsupported AGAL opcode");
    }

    const dest = data.getUint32(offset + 4, true);
    const unary = UNARY.has(opcode);
    if (unary && (data.getUint32(offset + 16, true) || data.getUint32(offset + 20, true))) {
      throw new Context3DError("agalUnusedSource", "Nonempty unused AGAL source");
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
        throw new Context3DError("agalDiscard", "Invalid AGAL discard");
      }

      lines.push(`if (${source(offset + 8)}.x < 0.0) { discard; }`);
      continue;
    }

    const mask = (dest >>> 16) & 255;
    if (mask === 0 || mask > 15) {
      throw new Context3DError("agalMask", "Invalid AGAL write mask");
    }

    const targetType = dest >>> 24;
    const targetIndex = dest & 65535;
    const target = register(targetType, targetIndex, true);
    if (stage === "fragment" && targetType === 3 && mask !== 15) {
      throw new Context3DError("agalColorMask", "AGAL color output must write all components");
    }
    const a = source(offset + 8);
    const b = unary || opcode === 0x28 ? "" : source(offset + 16);

    // AIR differs for overlaps that shuffle written lanes. Replicating the
    // destination lane for a scalar write is safe; unused lanes do not matter.
    if (opcode === 5 || opcode === 9 || opcode === 0x0b || opcode === 0x0c || opcode === 0x0d) {
      for (let operand = offset + 8; operand <= offset + (unary ? 8 : 16); operand += 8) {
        const low = data.getUint32(operand, true);
        if (data.getUint32(operand + 4, true) === dest >>> 24 && (low & 65535) === (dest & 65535)) {
          for (let lane = 0; lane < 4; lane++) {
            if (mask & (1 << lane) && ((low >>> (24 + lane * 2)) & 3) !== lane) {
              throw new Context3DError(
                "unsupported",
                "Unsupported AGAL swizzled scalar-math overlap",
              );
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
      case 5:
        expression = `(vec4(1.0) / ${a})`;
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
        // As Direct3D's pow, which AIR draws with: |a|^b, by exp2 and log2 as
        // there (0^-1 is infinity, 0^0 NaN). GLSL's pow leaves a negative base
        // undefined, and GPUs give NaN, so lit surfaces drew black.
        expression = `exp2(${b} * log2(abs(${a})))`;
        break;
      case 0x0c:
        expression = `log2(${a})`;
        break;
      case 0x0d:
        expression = `exp2(${a})`;
        break;
      case 0x0f:
        expression = `sin(${a})`;
        break;
      case 0x10:
        expression = `cos(${a})`;
        break;
      case 0x0e:
      case 0x11:
        if (mask !== 7) {
          throw new Context3DError("unsupported", "Unsupported AGAL vector write mask");
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
        const matrixHigh = data.getUint32(offset + 20, true);
        const matrixType = matrixHigh & 255;
        if (
          (rows === 3 && (mask & 8 || ((matrixType === 2 || matrixHigh >>> 31) && mask !== 7))) ||
          (matrixType !== 1 && matrixType !== 2) ||
          data.getUint32(offset + 16, true) >>> 24 !== 0xe4
        ) {
          throw new Context3DError("unsupported", "Unsupported AGAL matrix operand or write mask");
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
        const index = low & 65535;
        const bias = data.getInt8(offset + 18) / 8;
        const mip = (high >>> 24) & 15;
        const filter = high >>> 28;
        if (
          stage !== "fragment" ||
          index >= 8 ||
          low >>> 24 !== 0 ||
          (high & ~0x73141000) !== 5 ||
          filter > 5 ||
          mip > 2
        ) {
          throw new Context3DError("agalSampler", "Unsupported AGAL sampler encoding");
        }

        const cube = (high & 0x1000) !== 0;
        const repeat = (high & 0x00100000) !== 0;
        const ignore = (high & 0x00040000) !== 0;
        const previous = samplers.get(index);
        if (previous && previous.bias !== bias) {
          throw new SamplerBiasError("Conflicting AGAL sampler biases");
        }

        if (
          previous &&
          (previous.filter !== filter ||
            previous.repeat !== repeat ||
            previous.mip !== mip ||
            previous.cube !== cube ||
            previous.ignore !== ignore)
        ) {
          throw new Context3DError("agalSampler", "Conflicting AGAL sampler states");
        }

        samplers.set(index, { index, filter, repeat, mip, cube, ignore, bias });
        names.set(`fs${index}`, `uniform ${cube ? "samplerCube" : "sampler2D"} fs${index};`);
        // Bias stays in the shader even when ignoresampler preserves runtime state.
        expression = `texture(fs${index}, ${a}.${cube ? "xyz" : "xy"}${bias === 0 ? "" : `, ${bias.toFixed(3)}`})`;
        break;
      }
      case 0x29:
        expression = `vec4(greaterThanEqual(${a}, ${b}))`;
        break;
      case 0x2a:
        expression = `vec4(lessThan(${a}, ${b}))`;
        break;
      case 0x2c:
        expression = `vec4(equal(${a}, ${b}))`;
        break;
      default:
        throw new Context3DError("agalOpcode", "Unsupported AGAL opcode");
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
    switch (targetType) {
      case 2:
        temporaries[targetIndex] |= mask;
        break;
      case 3:
        output |= mask;
        break;
      case 4:
        varyings[targetIndex] |= mask;
        break;
    }
  }

  if (output !== 15) {
    throw new Context3DError(
      stage === "vertex" ? "agalVertexOutput" : "agalFragmentOutput",
      "AGAL program does not write its complete output",
    );
  }

  const declarations = [...names.values()].join("\n");
  const finish =
    stage === "vertex"
      ? "gl_Position = vec4(result.x, result.y * targetY, result.z * 2.0 - result.w, result.w);"
      : "color = result;";
  return {
    source: `#version 300 es
precision highp float;
${declarations}
${
  indirect
    ? `vec4 readConstant(float address, float offset) {
  float index = roundEven(address) + offset;
  if (!(index >= 0.0 && index < 128.0)) { return vec4(0.0); }
  return vc[int(index)];
}`
    : ""
}
${stage === "fragment" ? "out vec4 color;" : "uniform float targetY;"}
void main() {
  vec4 result = vec4(0.0);
  ${lines.join("\n  ")}
  ${finish}
}`,
    varyings,
    attributes: [...attributes],
    constants: [...constants],
    indirect,
    samplers: [...samplers.values()],
  };
}
