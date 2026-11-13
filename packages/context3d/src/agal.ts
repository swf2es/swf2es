// AGAL 1, 2 and 3 to GLSL ES 3.00, with AIR's validation.
// Format: https://github.com/adobe/glsl2agal/blob/master/agalassembler/agal.h
// Each version's registers and rules are as AIR 51 enforces them (tests/context3d/AGALProfiles.as).
import { type Profile, profileLimits, SamplerBiasError } from "./backend.js";
import { Context3DError } from "./errors.js";

export type ProgramType = "vertex" | "fragment";

export interface SamplerSource {
  index: number;
  /** What the sampler reads: 0 RGBA, 1 DXT1 ("compressed"), 2 DXT5 ("compressedAlpha"). */
  format: number;
  filter: number;
  /** AGAL's wrap: 0 clamp, 1 repeat, 2 clamp_u_repeat_v, 3 repeat_u_clamp_v. */
  wrap: number;
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
  /** Colour outputs a fragment program writes, oc0 up: 1 to 4. */
  outputs: number;
}

/** The registers each AGAL version has, and how long its programs may be. */
interface Registers {
  attributes: number;
  vertexConstants: number;
  fragmentConstants: number;
  temporaries: number;
  varyings: number;
  samplers: number;
  outputs: number;
  depth: boolean;
  tokens: number;
}

function registers(version: number, profile: Profile): Registers {
  if (version === 1) {
    return {
      attributes: 8,
      vertexConstants: 128,
      fragmentConstants: 28,
      temporaries: profile === "baselineConstrained" ? 7 : 8,
      varyings: 8,
      samplers: 8,
      outputs: 1,
      depth: false,
      tokens: 200,
    };
  }

  const constrained = profile === "standardConstrained";
  return {
    attributes: 8,
    vertexConstants: 250,
    fragmentConstants: 64,
    temporaries: 26,
    varyings: constrained ? 8 : 10,
    samplers: constrained ? 8 : 16,
    outputs: constrained ? 1 : 4,
    depth: !constrained,
    tokens: 1024,
  };
}

const SUPPORTED = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
  0x15, 0x16, 0x17, 0x18, 0x19, 0x27, 0x28, 0x29, 0x2a, 0x2c, 0x2d,
]);
/** ddx, ddy and the conditionals: ife, ine, ifg, ifl, els and eif. */
const VERSION2 = new Set([0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21]);
const UNARY = new Set([
  0, 5, 8, 9, 0x0a, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x14, 0x15, 0x16, 0x1a, 0x1b, 0x27,
]);
const COMPARISONS = ["==", "!=", ">", "<"];
/**
 * The vertex constants an indirect read reaches: AIR's reach the first 128 in AGAL 2 and 3
 * too, and read 0 past them; the rest only direct reads reach.
 */
export const INDIRECT_BANK = 128;
/** The instructions a baselineConstrained fragment program may have. */
const CONSTRAINED_FRAGMENT = 96;
/** The deepest AIR nests conditionals. */
const NESTING = 4;

/** A conditional being translated: its predicate, and what was written before and in it. */
interface Block {
  predicate: string;
  condition: string;
  parent: string;
  otherwise: boolean;
  instructions: number;
  temporaries: Uint8Array;
  varyings: Uint8Array;
}

export function translate(
  bytes: Uint8Array,
  stage: ProgramType,
  profile: Profile = "baseline",
): ShaderSource {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 31 || (bytes.length - 7) % 24 !== 0) {
    throw new Context3DError("agalLength", "Invalid AGAL program length");
  }

  // AIR takes version 0 as 1.
  const version = data.getUint32(1, true) || 1;
  const limits = registers(Math.min(version, 3), profile);
  if ((bytes.length - 7) / 24 > limits.tokens) {
    throw new Context3DError("agalTokens", "Too many AGAL instructions");
  }
  if (bytes[0] !== 0xa0) {
    throw new Context3DError("agalMagic", "Invalid AGAL magic byte");
  }
  if (version > profileLimits(profile).agal) {
    throw new Context3DError(
      "agalProfileVersion",
      `AGAL version ${version} is not valid in the ${profile} profile`,
    );
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

  const bank = INDIRECT_BANK;
  const names = new Map<string, string>();
  const attributes = new Set<number>();
  const constants = new Set<number>();
  const samplers = new Map<number, SamplerSource>();
  const lines: string[] = [];
  const components = "xyzw";
  let output = 0;
  let outputs = 0;
  let temporaries: Uint8Array = new Uint8Array(limits.temporaries);
  let varyings: Uint8Array = new Uint8Array(limits.varyings);
  const blocks: Block[] = [];
  let hoisted = 0;
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
  const outputInBlock = (): void => {
    if (blocks.length) {
      throw new Context3DError(
        "agalConditionOutput",
        "AGAL outputs cannot be written in conditionals",
      );
    }
  };
  const register = (type: number, index: number, write: boolean): string => {
    let name: string;
    let declaration: string;
    switch (type) {
      case 0:
        if (write || stage !== "vertex" || index >= limits.attributes) {
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
        if (
          write ||
          index >= (stage === "vertex" ? limits.vertexConstants : limits.fragmentConstants)
        ) {
          throw new Context3DError(
            write ? "agalConstantWrite" : "agalConstantIndex",
            "Invalid AGAL constant",
          );
        }

        if (indirect && stage === "vertex" && index < bank) {
          names.set("vc", `uniform vec4 vc[${bank}];`);
          return `vc[${index}]`;
        }

        name = `${stage === "vertex" ? "vc" : "fc"}${index}`;
        declaration = `uniform vec4 ${name};`;
        constants.add(index);
        break;
      case 2:
        if (index >= limits.temporaries) {
          throw new Context3DError("agalTemporaryIndex", "Invalid AGAL temporary");
        }
        name = `t${index}`;
        declaration = `vec4 ${name};`;
        break;
      case 3:
        if (!write || index >= (stage === "vertex" ? 1 : limits.outputs)) {
          throw new Context3DError(
            write ? "agalOutputIndex" : "agalOutputRead",
            "Invalid AGAL output",
          );
        }
        outputInBlock();
        if (index === 0) {
          return "result";
        }

        name = `result${index}`;
        declaration = `vec4 ${name} = vec4(0.0);`;
        break;
      case 4:
        if (index >= limits.varyings || write !== (stage === "vertex")) {
          throw new Context3DError(
            index >= limits.varyings
              ? "agalVaryingIndex"
              : write
                ? "agalVaryingWrite"
                : "agalVaryingRead",
            "Invalid AGAL varying",
          );
        }
        name = `v${index}`;
        declaration = `${stage === "vertex" ? "out" : "in"} vec4 ${name};`;
        break;
      case 6:
        if (stage === "vertex") {
          throw new Context3DError("agalDepthStage", "AGAL depth output in a vertex program");
        }
        if (!write) {
          throw new Context3DError("agalRegister", "Unsupported AGAL register");
        }
        if (!limits.depth || index !== 0) {
          throw new Context3DError("agalDepthIndex", "Invalid AGAL depth output");
        }
        outputInBlock();
        name = "depth";
        declaration = "vec4 depth = vec4(0.0);";
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
        component > 3
      ) {
        throw new Context3DError("agalIndirect", "Unsupported AGAL indirect constant");
      }

      const index = register(type, low & 65535, false);
      if (type === 2) {
        readTemporary(low & 65535, 1 << component);
      }
      names.set("vc", `uniform vec4 vc[${bank}];`);
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

  const scalar = (offset: number): boolean => {
    const swizzle = data.getUint32(offset, true) >>> 24;
    return swizzle === (swizzle & 3) * 0x55;
  };

  for (let offset = 7; offset < bytes.length; offset += 24) {
    const opcode = data.getUint32(offset, true);
    if (opcode > 0x2e) {
      throw new Context3DError("agalOpcodeRange", "AGAL opcode out of range");
    }
    // tld, a vertex texture read AIR names but does not do: its sampler is refused first.
    if (opcode === 0x2e && stage === "vertex") {
      throw new Context3DError("agalSamplerStage", "AGAL sampler in a vertex program");
    }
    // Unsupported instructions may have no destination or a sampler operand;
    // do not misreport those layouts as malformed arithmetic registers.
    if (!SUPPORTED.has(opcode) && !VERSION2.has(opcode)) {
      throw new Context3DError("agalOpcode", "Unsupported AGAL opcode");
    }
    if ((opcode === 0x1a || opcode === 0x1b) && stage !== "fragment") {
      throw new Context3DError("agalFragmentOnly", "AGAL opcode only in fragment programs");
    }
    if (VERSION2.has(opcode) && version < 2) {
      throw new Context3DError("agalOpcodeVersion", "AGAL opcode needs version 2");
    }

    const dest = data.getUint32(offset + 4, true);
    const block = blocks[blocks.length - 1];
    if (opcode === 0x20 || opcode === 0x21) {
      if (!block) {
        throw new Context3DError(
          opcode === 0x20 ? "agalElse" : "agalEndIf",
          "AGAL else or eif without if",
        );
      }
      if (opcode === 0x20 && block.otherwise) {
        throw new Context3DError("agalElse", "AGAL else chain broken");
      }
      if (!block.instructions) {
        throw new Context3DError("agalEmptyBranch", "Empty AGAL conditional branch");
      }

      if (opcode === 0x20) {
        // The else branch starts from what was written before the if.
        block.otherwise = true;
        temporaries = block.temporaries.slice();
        varyings = block.varyings.slice();
        block.instructions = 0;
        block.predicate = `p${offset}`;
        lines.push(`bool ${block.predicate} = ${block.parent}!${block.condition};`);
        continue;
      }

      // After the eif AIR counts what the else branch wrote, or, with none, what was written
      // before the if: an if branch's writes alone are not.
      if (!block.otherwise) {
        temporaries = block.temporaries;
        varyings = block.varyings;
      }
      blocks.pop();
      continue;
    }

    if (opcode >= 0x1c && opcode <= 0x1f) {
      if (dest !== 0) {
        throw new Context3DError("agalConditionDestination", "AGAL conditional with a destination");
      }
      if (!scalar(offset + 8) || !scalar(offset + 16)) {
        throw new Context3DError("agalScalar", "AGAL conditional operands must be scalar");
      }
      if (blocks.length === NESTING) {
        throw new Context3DError("agalNesting", "AGAL conditionals nested too deep");
      }

      const a = source(offset + 8);
      const b = source(offset + 16);
      if (block) {
        block.instructions++;
      }
      // Both branches run for every pixel and only their writes are predicated, as
      // Direct3D's predication runs them: derivatives stay defined.
      const parent = block ? `${block.predicate} && ` : "";
      const condition = `c${offset}`;
      const name = `p${offset}`;
      lines.push(`bool ${condition} = ${a}.x ${COMPARISONS[opcode - 0x1c]} ${b}.x;`);
      lines.push(`bool ${name} = ${parent}${condition};`);
      blocks.push({
        predicate: name,
        condition,
        parent,
        otherwise: false,
        instructions: 0,
        temporaries: temporaries.slice(),
        varyings: varyings.slice(),
      });
      continue;
    }

    const unary = UNARY.has(opcode);
    if (unary && (data.getUint32(offset + 16, true) || data.getUint32(offset + 20, true))) {
      throw new Context3DError("agalUnusedSource", "Nonempty unused AGAL source");
    }
    if (block) {
      block.instructions++;
    }

    if (opcode === 0x27) {
      const operand = data.getUint32(offset + 8, true);
      const type = data.getUint32(offset + 12, true);
      const swizzle = operand >>> 24;
      if (type === 1 && stage === "fragment" && dest === 0) {
        throw new Context3DError("agalConstants", "AGAL operands are both constants");
      }
      if (
        stage !== "fragment" ||
        dest !== 0 ||
        (type !== 2 && type !== 4) ||
        swizzle !== (swizzle & 3) * 0x55
      ) {
        throw new Context3DError("agalDiscard", "Invalid AGAL discard");
      }

      const p = block ? `${block.predicate} && ` : "";
      lines.push(`if (${p}${source(offset + 8)}.x < 0.0) { discard; }`);
      continue;
    }

    const mask = (dest >>> 16) & 255;
    if (mask === 0 || mask > 15) {
      throw new Context3DError("agalMask", "Invalid AGAL write mask");
    }

    const targetType = dest >>> 24;
    const targetIndex = dest & 65535;
    const target = register(targetType, targetIndex, true);
    if (stage === "fragment" && targetType === 3) {
      if (mask !== 15) {
        throw new Context3DError("agalColorMask", "AGAL color output must write all components");
      }
      if (outputs & (1 << targetIndex)) {
        throw new Context3DError("agalOutputTwice", "AGAL color output written twice");
      }
    }
    if (targetType === 6 && mask !== 1) {
      throw new Context3DError("agalDepthMask", "AGAL depth output must write only x");
    }
    if (opcode === 0x28 && block && data.getUint32(offset + 12, true) !== 4) {
      throw new Context3DError(
        "agalConditionTexture",
        "AGAL texture reads in conditionals take only varyings",
      );
    }
    if ((opcode === 0x1a || opcode === 0x1b) && block) {
      throw new Context3DError("agalConditionDerivative", "AGAL ddx and ddy in a conditional");
    }
    // Two constants make a value AIR wants precomputed; a lone one in kil, ddx and ddy too.
    if (
      opcode !== 0 &&
      opcode !== 0x28 &&
      (data.getUint32(offset + 12, true) & 255) === 1 &&
      (unary ? opcode === 0x1a || opcode === 0x1b : (data.getUint32(offset + 20, true) & 255) === 1)
    ) {
      throw new Context3DError("agalConstants", "AGAL operands are both constants");
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
        // As Direct3D's pow, which AIR draws with: |a|^b. GLSL leaves a
        // negative base undefined, where GPUs give NaN, which draws black.
        expression = `pow(abs(${a}), ${b})`;
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
      case 0x1a:
        expression = `dFdx(${a})`;
        break;
      case 0x1b:
        // AIR's y grows down its target; GL's up the back buffer, and down a texture, which
        // targetY flips.
        names.set("targetY", "uniform float targetY;");
        expression = `(-targetY * dFdy(${a}))`;
        break;
      case 0x28: {
        const low = data.getUint32(offset + 16, true);
        const high = data.getUint32(offset + 20, true);
        const index = low & 65535;
        const bias = data.getInt8(offset + 18) / 8;
        const format = (high >>> 8) & 15;
        const dimension = (high >>> 12) & 15;
        const special = (high >>> 16) & 15;
        const wrap = (high >>> 20) & 15;
        const mip = (high >>> 24) & 15;
        const filter = high >>> 28;
        if (stage !== "fragment" || low >>> 24 !== 0 || (high & 255) !== 5) {
          throw new Context3DError("agalSampler", "Unsupported AGAL sampler encoding");
        }
        if (index >= limits.samplers) {
          throw new Context3DError("agalSamplerIndex", "AGAL sampler index out of bounds");
        }
        if (dimension > 1) {
          throw new Context3DError("agalSamplerDimension", "Unknown AGAL sampler dimension");
        }
        // Of the special flags only ignoresampler: AIR refuses centroid and single.
        if (special & ~4 || wrap > 3) {
          throw new Context3DError("agalSampler", "Unsupported AGAL sampler encoding");
        }
        if (mip > 2) {
          throw new Context3DError("agalSamplerMip", "Unknown AGAL sampler mipmap mode");
        }
        if (filter > 5) {
          throw new Context3DError("agalSamplerFilter", "Unknown AGAL sampler filter");
        }

        const cube = dimension === 1;
        const ignore = (special & 4) !== 0;
        const previous = samplers.get(index);
        if (previous && previous.bias !== bias) {
          throw new SamplerBiasError("Conflicting AGAL sampler biases");
        }

        if (
          previous &&
          (previous.format !== format ||
            previous.filter !== filter ||
            previous.wrap !== wrap ||
            previous.mip !== mip ||
            previous.cube !== cube ||
            previous.ignore !== ignore)
        ) {
          throw new Context3DError("agalSampler", "Conflicting AGAL sampler states");
        }

        samplers.set(index, { index, format, filter, wrap, mip, cube, ignore, bias });
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
      case 0x2d:
        expression = `vec4(notEqual(${a}, ${b}))`;
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
    if (!block) {
      lines.push(`${target}.${lanes} = ${expression}.${lanes};`);
    } else if (opcode === 0x28) {
      // A texture read's derivatives are taken outside the branch, where every pixel of a
      // quad computes them.
      const value = `h${hoisted++}`;
      lines.push(`vec4 ${value} = ${expression};`);
      lines.push(`if (${block.predicate}) { ${target}.${lanes} = ${value}.${lanes}; }`);
    } else {
      lines.push(`if (${block.predicate}) { ${target}.${lanes} = ${expression}.${lanes}; }`);
    }
    switch (targetType) {
      case 2:
        temporaries[targetIndex] |= mask;
        break;
      case 3:
        if (stage === "fragment") {
          outputs |= 1 << targetIndex;
        }
        if (targetIndex === 0) {
          output |= mask;
        }
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
  if (outputs & (outputs + 1)) {
    throw new Context3DError("agalOutputSlots", "AGAL color outputs are not consecutive");
  }
  // ps_2_0's 64 arithmetic and 32 texture instructions, which AIR counts once the program
  // is valid; an instruction here is taken as one there.
  if (
    profile === "baselineConstrained" &&
    stage === "fragment" &&
    (bytes.length - 7) / 24 > CONSTRAINED_FRAGMENT
  ) {
    throw new Context3DError("agalNativeLength", "Too many instructions for the native shader");
  }

  const count = stage === "fragment" ? 32 - Math.clz32(outputs) : 1;
  let results: string;
  let finish: string;
  if (stage === "vertex") {
    results = "uniform float targetY;";
    finish =
      "gl_Position = vec4(result.x, result.y * targetY, result.z * 2.0 - result.w, result.w);";
  } else if (count === 1) {
    results = "out vec4 color;";
    finish = "color = result;";
  } else {
    const outs: string[] = [];
    const sets: string[] = [];
    for (let i = 0; i < count; i++) {
      outs.push(`layout(location = ${i}) out vec4 color${i || ""};`);
      sets.push(`color${i || ""} = result${i || ""};`);
    }
    results = outs.join("\n");
    finish = sets.join("\n  ");
  }
  if (names.has("depth")) {
    finish += "\n  gl_FragDepth = depth.x;";
  }

  return {
    source: `#version 300 es
precision highp float;
${[...names.values()].join("\n")}
${
  indirect
    ? `vec4 readConstant(float address, float offset) {
  float index = roundEven(address) + offset;
  if (!(index >= 0.0 && index < ${bank}.0)) { return vec4(0.0); }
  return vc[int(index)];
}`
    : ""
}
${results}
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
    outputs: count,
  };
}
