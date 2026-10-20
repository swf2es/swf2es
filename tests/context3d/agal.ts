// Deliberately small AGAL v1 slice for the opt-in Context3D probe.
// Format: https://github.com/adobe/glsl2agal/blob/master/agalassembler/agal.h
export type ProgramType = "vertex" | "fragment";

export interface ShaderSource {
  source: string;
  attributes: number[];
  constants: number[];
}

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

  for (let offset = 7; offset < bytes.length; offset += 24) {
    if (data.getUint32(offset, true) !== 0) {
      throw new Error("Context3D experiment supports only AGAL mov");
    }

    const dest = data.getUint32(offset + 4, true);
    const low = data.getUint32(offset + 8, true);
    const high = data.getUint32(offset + 12, true);
    // Indirect constants, indexing and the unused second source are not
    // supported by this slice; never silently turn them into a direct read.
    if (
      high >>> 8 ||
      ((low >>> 16) & 255) !== 0 ||
      data.getUint32(offset + 16, true) !== 0 ||
      data.getUint32(offset + 20, true) !== 0
    ) {
      throw new Error("Unsupported AGAL source encoding");
    }

    const mask = (dest >>> 16) & 255;
    if (mask === 0 || mask > 15) {
      throw new Error("Invalid AGAL write mask");
    }

    const target = register(dest >>> 24, dest & 65535, true);
    const source = register(high & 255, low & 65535, false);
    const swizzle = low >>> 24;
    let left = "";
    let right = "";
    for (let c = 0; c < 4; c++) {
      if (mask & (1 << c)) {
        left += components[c];
        right += components[(swizzle >>> (c * 2)) & 3];
      }
    }

    lines.push(`${target}.${left} = ${source}.${right};`);
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
  };
}
