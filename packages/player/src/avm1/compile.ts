// AVM1's blocks compiled on first use, each byte for byte its AOT entry,
// and the units their code goes on in (docs/avm1.md, "Units") likewise.
import type { ActionBlocks, Codegen } from "@swf2es/codegen";
import { avm1 } from "@swf2es/runtime";
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

/** A unit's first choice: its code until it runs, then its regions; and its limits. */
interface Unit {
  code: string | null;
  regions: avm1.Region[] | null;
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
  const own = new avm1.OwnUnits<avm1.Region[]>();
  // Units of the same code are one, as the module writes them once: by
  // the code's hash and length, the code itself not kept.
  const byCode = new Map<number, avm1.Region[][]>();
  const units: avm1.Units = {
    blocks,
    unit(at, end, bound, five) {
      const index = at * 2 + (five ? 1 : 0);
      let unit = first.get(index);
      if (unit === undefined) {
        const segment = segmentEnd(bounds, bytes.length, at);
        const compiled = codegen.compileActionUnit(bytes, actions, {
          at,
          end: segment,
          bound: segment,
          five,
        });
        // One that only its own region runs never runs as a first choice.
        unit = { ...compiled, code: compiled.high >= 0 ? compiled.code : null, regions: null };
        first.set(index, unit);
      }

      if (unit.high >= 0 && unit.high <= end && unit.reach <= bound) {
        if (unit.regions === null) {
          unit.regions = regionsOf(unit.code ?? "", at);
          unit.code = null;
        }

        return unit.regions;
      }

      let regions = own.get(at, end, bound, five);
      if (regions === undefined) {
        const { code } = codegen.compileActionUnit(bytes, actions, { at, end, bound, five });
        regions = regionsOf(code, at);
        own.set(at, end, bound, five, regions);
      }

      return regions;
    },
  };
  const regionsOf = (code: string, at: number): avm1.Region[] => {
    const hash = hashOf(code);
    const same = byCode.get(hash);
    for (const regions of same ?? []) {
      // The regions' source is the code they were made of.
      if (`[${regions.join(", ")}]` === code) {
        return regions;
      }
    }

    const regions = evaluate(code, `at-${at}`);
    known.set(regions, units);
    if (same === undefined) {
      byCode.set(hash, [regions]);
    } else {
      same.push(regions);
    }

    return regions;
  };
  return units;
}

/** FNV-1a of `text`'s code units, and its length. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }

  return (hash >>> 0) * 0x100000 + (text.length & 0xfffff);
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
