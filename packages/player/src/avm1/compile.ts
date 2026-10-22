// AVM1's blocks compiled on first use, each byte for byte its AOT entry,
// and the units their code goes on in (docs/avm1.md, "Units") likewise.
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
  const evaluate = (entry: string, name: string): avm1.Region[] => {
    // AVM1 identifies its callers by region arrays, including on engines
    // whose Function stack frames do not name their sourceURL.
    const source = `export default function (rt) {\nconst V = rt.version(${version});\n${version < 5 ? "const V5 = rt.version(5);\n" : ""}return [\n${entry}\n];\n}\n`;
    const factory = evaluateFunction(source, `swf2es-avm1-${script}-${name}.js`);
    return (factory as unknown as avm1.Factory)(rt)[0];
  };
  const blocks = actions.blocks.map((_, index) => {
    const regions: avm1.Region[] = [];
    regions.push((cx) => {
      const entry = codegen.compileActionBlocks(bytes, actions, [index]).get(index);
      if (entry === undefined) {
        throw new Error(`swf2es: no compiled AVM1 block ${index}`);
      }

      const compiled = evaluate(entry, `${index}`);
      regions.length = 0;
      for (const region of compiled) {
        regions.push(region);
      }

      return regions[0](cx);
    });
    return regions;
  });
  const units = unitsOf(codegen, bytes, actions, blocks, rt.realm.units, evaluate);
  for (const regions of blocks) {
    rt.realm.units.set(regions, units);
  }

  return blocks;
}

interface Unit {
  regions: avm1.Region[];
  high: number;
  reach: number;
}

/**
 * A SWF's units, each compiled as control first goes on in it: first the
 * one of a region and bytes that end at the next bound of a block, which
 * most regions can run, else the region's own (codegen's module.ts).
 */
function unitsOf(
  codegen: Codegen,
  bytes: Uint8Array,
  actions: ActionBlocks,
  blocks: avm1.Blocks,
  known: WeakMap<avm1.Region[], avm1.Units>,
  evaluate: (entry: string, name: string) => avm1.Region[],
): avm1.Units {
  const bounds = blockBounds(bytes.length, actions);
  // By offset, twice and once more for SWF 5's functions; by key, those of a region alone.
  const first = new Map<number, Unit>();
  const own = new Map<string, avm1.Region[]>();
  // Units of the same code are one, as the module writes them once.
  const byCode = new Map<string, avm1.Region[]>();
  const units: avm1.Units = {
    blocks,
    unit(at, end, bound, five) {
      const index = at * 2 + (five ? 1 : 0);
      let unit = first.get(index);
      if (unit === undefined) {
        const segment = segmentEnd(bounds, bytes.length, at);
        unit = compile(at, segment, segment, five);
        first.set(index, unit);
      }

      if (unit.high >= 0 && unit.high <= end && unit.reach <= bound) {
        return unit.regions;
      }

      const key = `${at},${end},${bound},${five ? 1 : 0}`;
      let regions = own.get(key);
      if (regions === undefined) {
        regions = compile(at, end, bound, five).regions;
        own.set(key, regions);
      }

      return regions;
    },
  };
  const compile = (at: number, end: number, bound: number, five: boolean): Unit => {
    const { code, high, reach } = codegen.compileActionUnit(bytes, actions, {
      at,
      end,
      bound,
      five,
    });
    let regions = byCode.get(code);
    if (regions === undefined) {
      regions = evaluate(code, `at-${at}`);
      byCode.set(code, regions);
      known.set(regions, units);
    }

    return { regions, high, reach };
  };
  return units;
}

/** The starts and ends of the SWF's blocks within its bytes, ascending, once each. */
function blockBounds(size: number, actions: ActionBlocks): number[] {
  const bounds = new Set<number>();
  for (const { offset, length } of actions.blocks) {
    if (offset >= 0 && length >= 0 && offset + length <= size) {
      bounds.add(offset);
      bounds.add(offset + length);
    }
  }

  return [...bounds].sort((a, b) => a - b);
}

/** The first of `bounds` past `at`, else the SWF's end, as codegen's units.ts finds it. */
function segmentEnd(bounds: number[], size: number, at: number): number {
  let low = 0;
  let high = bounds.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (bounds[mid] <= at) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low < bounds.length ? bounds[low] : size;
}
