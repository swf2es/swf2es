// AVM1's blocks compiled on first use, each byte for byte its AOT entry.
import type { ActionBlocks, Codegen } from "@swf2es/codegen";
import type { avm1 } from "@swf2es/runtime";
import { evaluateFunction } from "../scripting/evaluate.js";

let scripts = 0;

/**
 * Stable region arrays let the runtime and ExternalInterface identify a
 * block before it is compiled; its functions keep that same array after.
 */
export function lazyBlocks(
  codegen: Codegen,
  bytes: Uint8Array,
  actions: ActionBlocks,
  rt: avm1.Runtime,
): avm1.Blocks {
  const script = ++scripts;
  const version = actions.version;
  return actions.blocks.map((_, index) => {
    const regions: avm1.Region[] = [];
    regions.push((cx) => {
      const entry = codegen.compileActionBlocks(bytes, actions, [index]).get(index);
      if (entry === undefined) {
        throw new Error(`swf2es: no compiled AVM1 block ${index}`);
      }

      // AVM1 identifies its callers by region arrays, including on engines
      // whose Function stack frames do not name their sourceURL.
      const source = `export default function (rt) {\nconst V = rt.version(${version});\n${version < 5 ? "const V5 = rt.version(5);\n" : ""}return [\n${entry}\n];\n}\n`;
      const factory = evaluateFunction(source, `swf2es-avm1-${script}-${index}.js`);
      const compiled = (factory as unknown as avm1.Factory)(rt)[0];
      regions.length = 0;
      for (const region of compiled) {
        regions.push(region);
      }

      return regions[0](cx);
    });
    return regions;
  });
}
