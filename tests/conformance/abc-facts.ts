// Compares swf2es' ABC parser with avmplus' abcdump by the facts both
// report, not by text: abcdump's own formatting has quirks we do not copy.
import { readFile } from "node:fs/promises";

const dir = new URL("../../packages/codegen/dist-test/", import.meta.url);
const { instantiate } = await import(new URL("testing.js", dir).href);
const module = await WebAssembly.compile(await readFile(new URL("testing.wasm", dir)));
const testing = await instantiate(module, { env: {} });

/** Table counts, and each method body's sizes keyed by method index. */
export interface AbcFacts {
  counts: Record<string, number>;
  bodies: Record<number, string>;
}

// abcdump names each table in its "// X count N" lines.
const COUNTS: Record<string, string> = {
  "Cpool strings": "strings",
  "Cpool namespaces": "namespaces",
  "Cpool nssets": "nssets",
  "Cpool names": "multinames",
  MethodInfo: "methods",
  MetadataInfo: "metadata",
  InstanceInfo: "classes",
  MethodBodies: "bodies",
};

const body = (
  localCount: number,
  maxScope: number,
  maxStack: number,
  length: number,
  offset: number,
) =>
  `local_count=${localCount} max_scope=${maxScope} max_stack=${maxStack} code_len=${length} code_offset=${offset}`;

export function abcdumpFacts(dump: string): AbcFacts {
  const facts: AbcFacts = { counts: {}, bodies: {} };
  let method = -1;

  for (const line of dump.split("\n")) {
    const count = line.match(/^\/\/ (.+?) count (\d+)/);
    if (count && COUNTS[count[1]]) {
      // An empty pool may be written with count 0 or 1; both mean no entries.
      const n = Number(count[2]);
      facts.counts[COUNTS[count[1]]] = count[1].startsWith("Cpool") ? Math.max(n, 1) : n;
      continue;
    }

    // A method's header names it; its body line follows.
    const id = line.match(/method_id=(\d+)/);
    if (id) {
      method = Number(id[1]);
    }

    const sizes = line.match(
      /^\s*\/\/ local_count=(\d+) max_scope=(\d+) max_stack=(\d+) framesize=\d+ code_len=(\d+) code_offset=(\d+)/,
    );
    if (sizes && method >= 0) {
      const [, locals, scope, stack, length, offset] = sizes.map(Number);
      facts.bodies[method] = body(locals, scope, stack, length, offset);
    }
  }

  return facts;
}

export function swf2esFacts(abc: Uint8Array): AbcFacts {
  const facts: AbcFacts = { counts: {}, bodies: {} };
  const pool = (testing.poolDump(abc) as string).split("\n");
  const tables = (testing.abcDump(abc) as string).split("\n");

  const error = [...pool, ...tables].find((l) => l.startsWith("error"));
  if (error) {
    facts.counts.error = Number(error.split(" ")[1]);
    return facts;
  }

  // Pool counts include the implicit entry 0, as abcdump's do.
  const entries = (lines: string[], kind: string) =>
    lines.filter((l) => l.startsWith(`${kind} `)).length;
  facts.counts.strings = entries(pool, "string") + 1;
  facts.counts.namespaces = entries(pool, "ns") + 1;
  facts.counts.nssets = entries(pool, "nsset") + 1;
  facts.counts.multinames = entries(pool, "mn") + 1;
  facts.counts.methods = entries(tables, "method");
  facts.counts.metadata = entries(tables, "metadata");
  facts.counts.classes = entries(tables, "instance");
  facts.counts.bodies = entries(tables, "body");

  for (const line of tables) {
    const b = line.match(
      /^body \d+ method=(\d+) stack=(\d+) locals=(\d+) scope=(\d+)\.\.(\d+) code=(\d+)\+(\d+)/,
    );
    if (b) {
      const [, method, stack, locals, init, max, offset, length] = b.map(Number);
      facts.bodies[method] = body(locals, max - init, stack, length, offset);
    }
  }

  return facts;
}

/** Every difference between two sets of facts, as readable lines. */
export function compareFacts(expected: AbcFacts, actual: AbcFacts): string[] {
  const differences: string[] = [];
  for (const key of new Set([...Object.keys(expected.counts), ...Object.keys(actual.counts)])) {
    if (expected.counts[key] !== actual.counts[key]) {
      differences.push(`${key}: abcdump ${expected.counts[key]}, swf2es ${actual.counts[key]}`);
    }
  }

  for (const method of new Set([...Object.keys(expected.bodies), ...Object.keys(actual.bodies)])) {
    const e = expected.bodies[Number(method)];
    const a = actual.bodies[Number(method)];
    if (e !== a) {
      differences.push(`method ${method} body: abcdump ${e}, swf2es ${a}`);
    }
  }

  return differences;
}
