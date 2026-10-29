// flash.display.ShaderData: a Pixel Bender kernel read from its bytecode
// (format's readPbj), and as dynamic properties what adl gives a script of
// it: the kernel's metadata of the first opcode, an int or a string, its
// name, a ShaderParameter for each parameter but the outputs and
// _OutCoord, and a ShaderInput for each input.
import { PBJ_STRING, PBJ_TYPES, PbjError, type PbjKernel, readPbj } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { OUT_COORD, PixelBender } from "../../../bitmap/pixel-bender.js";
import type { Scripting } from "../../../scripting.js";

type Value = avm2.Value;
type AsObject = avm2.AsObject;

/** A kernel's program, compiled when a job first runs it. */
const programs = new WeakMap<PbjKernel, PixelBender>();

export function programOf(kernel: PbjKernel): PixelBender {
  let program = programs.get(kernel);
  if (!program) {
    program = new PixelBender(kernel);
    programs.set(kernel, program);
  }

  return program;
}

/** A metadata value as adl gives it: a string, else a new Array of its numbers. */
function metadataValue(s: Scripting, value: string | number[]): Value {
  return typeof value === "string" ? value : s.rt.array([...value]);
}

export function shaderDataNatives(s: Scripting): avm2.Natives {
  const natives: avm2.Natives = {};

  class ShaderDataNatives {
    declare $kernel: PbjKernel | undefined;
    declare $d: Map<string, Value>;

    "flash.display:ShaderData::_setByteCode"(code: Value): void {
      if (code === null || code === undefined) {
        throw s.rt.error("TypeError", 2007, "byteCode");
      }

      // The whole ByteArray, whatever its position, which is left at its end.
      const bytes = avm2.bytesOf(s.rt, code as AsObject);
      let kernel: PbjKernel;
      try {
        kernel = readPbj(bytes.buffer.subarray(0, bytes.length));
      } catch (e) {
        if (!(e instanceof PbjError)) {
          throw e;
        }

        throw e.errorID === 2030
          ? s.rt.error("flash.errors::EOFError", 2030)
          : s.rt.error("ArgumentError", 2004);
      } finally {
        bytes.position = bytes.length;
      }

      this.$kernel = kernel;
      const own = this.$d;
      for (const m of kernel.metadata) {
        // An int of the kernel's is an int, not an Array of one.
        own.set(m.key, typeof m.value === "string" ? m.value : m.value[0]);
      }

      if (kernel.name !== null) {
        own.set("name", kernel.name);
      }

      let index = 0;
      for (const p of kernel.parameters) {
        if (p.output || p.name === OUT_COORD) {
          continue;
        }

        const o = s.rt.construct(s.rt.classNamed("flash.display::ShaderParameter")) as AsObject;
        o.$type = PBJ_TYPES[p.type] ?? null;
        o.$index = index++;
        o.$value = null;
        for (const m of p.metadata) {
          o.$d.set(m.key, metadataValue(s, m.value));
          if (m.key === "defaultValue") {
            o.$value = m.type === PBJ_STRING ? null : metadataValue(s, m.value);
          }
        }

        o.$d.set("name", p.name);
        own.set(p.name, o);
      }

      for (const input of kernel.inputs) {
        const o = s.rt.construct(s.rt.classNamed("flash.display::ShaderInput")) as AsObject;
        o.$channels = input.channels;
        o.$index = input.index;
        o.$d.set("name", input.name);
        own.set(input.name, o);
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display::ShaderData", ShaderDataNatives);
  return natives;
}
