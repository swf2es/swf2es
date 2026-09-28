// Compares swf2es' ABC parser with avmplus' abcdump by the facts both
// report, not by text: abcdump's own formatting has quirks we do not copy.
// The test build, which collects garbage between calls as the tests' does.
import { testing } from "../tests/unit/codegen/testing-module.ts";

/**
 * Table counts, each method body's sizes, and each body's instructions as
 * "offset name", keyed by method index.
 */
export interface AbcFacts {
  counts: Record<string, number>;
  bodies: Record<number, string>;
  code: Record<number, string[]>;
}

// abcdump names each table in its "// X count N" lines. Its MetadataInfo
// line prints the last entry's item count instead, so metadata is not compared.
const COUNTS: Record<string, string> = {
  "Cpool strings": "strings",
  "Cpool namespaces": "namespaces",
  "Cpool nssets": "nssets",
  "Cpool names": "multinames",
  MethodInfo: "methods",
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
  const facts: AbcFacts = { counts: {}, bodies: {}, code: {} };
  let method = -1;
  // The method whose disassembly is being read, until its closing brace.
  let inCode = -1;

  for (const line of dump.split("\n")) {
    const count = line.match(/^\/\/ (.+?) count (\d+)/);
    if (count && COUNTS[count[1]]) {
      // An empty pool may be written with count 0 or 1; both mean no entries.
      const n = Number(count[2]);
      facts.counts[COUNTS[count[1]]] = count[1].startsWith("Cpool") ? Math.max(n, 1) : n;
      continue;
    }

    if (inCode >= 0) {
      if (/^\s*\}\s*$/.test(line)) {
        inCode = -1;
        continue;
      }

      const instruction = line.match(/^\s*(\d+)\s+(\w+)/);
      if (instruction) {
        facts.code[inCode].push(`${instruction[1]} ${instruction[2]}`);
      }
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
      facts.code[method] = [];
      inCode = method;
    }
  }

  return facts;
}

/** swf2es' facts about an ABC; `builtin` parses it as one the player ships. */
export function swf2esFacts(abc: Uint8Array, builtin = false): AbcFacts {
  const facts: AbcFacts = { counts: {}, bodies: {}, code: {} };
  const pool = (testing.poolDump(abc) as string).split("\n");
  const tables = (testing.abcDump(abc, builtin) as string).split("\n");

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

  let method = -1;
  for (const line of (testing.codeDump(abc, builtin) as string).split("\n")) {
    const header = line.match(/^body \d+ method (\d+)/);
    if (header) {
      method = Number(header[1]);
      facts.code[method] = [];
      continue;
    }

    const instruction = line.match(/^\s+(\d+) (\w+)/);
    if (instruction) {
      facts.code[method].push(`${instruction[1]} ${instruction[2]}`);
    } else if (line.trim().startsWith("error")) {
      facts.code[method].push(line.trim());
    }
  }

  return facts;
}

/**
 * Every difference between two sets of facts, as readable lines. abcdump
 * disassembles code in a straight line while swf2es decodes only reachable
 * code, so each decoded instruction must be in abcdump's list, not the
 * reverse; `unreachable` counts the ones abcdump lists beyond ours.
 */
export function compareFacts(
  expected: AbcFacts,
  actual: AbcFacts,
  unreachable = { count: 0 },
): string[] {
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

  for (const method of Object.keys(actual.code)) {
    const listed = new Set(expected.code[Number(method)] ?? []);
    // Verifier errors are compared against avmshell's output; see verifyErrors.
    const decoded = actual.code[Number(method)].filter((l) => !l.startsWith("error"));
    for (const instruction of decoded) {
      if (!listed.has(instruction)) {
        differences.push(
          `method ${method}: swf2es decoded "${instruction}", which abcdump does not list`,
        );
      }
    }
    unreachable.count += listed.size - decoded.length;
  }

  return differences;
}

/**
 * The VerifyError numbers swf2es reports for an ABC's method bodies, each
 * once. avmshell verifies a method only when it first runs, so these are
 * compared with the VerifyErrors avmshell printed.
 */
export function verifyErrors(facts: AbcFacts): number[] {
  const errors = new Set<number>();
  for (const lines of Object.values(facts.code)) {
    for (const line of lines) {
      if (line.startsWith("error")) {
        errors.add(Number(line.split(" ")[1]));
      }
    }
  }

  return [...errors].sort((a, b) => a - b);
}

/**
 * The error swf2es reports while linking `abc` into a domain after
 * `builtins` (such as builtin and shell_toplevel) and resolving the types
 * of all its traits, or 0; `builtin` links `abc` as a builtin ABC too.
 */
export function linkError(builtins: Uint8Array[], abc: Uint8Array, builtin = false): number {
  testing.domainReset(50);
  for (const b of builtins) {
    const error = testing.domainAdd(b, true) as number;
    if (error) {
      throw new Error(`builtin ABC rejected with ${error}`);
    }
  }

  const first = testing.domainTraitsCount() as number;
  return (testing.domainAdd(abc, builtin) as number) || (testing.domainResolve(first) as number);
}

/**
 * The VerifyErrors swf2es reports for `abc` loaded after `builtins`: the
 * linking error if it does not link, else each distinct error of the
 * methods its scripts can run, verified with types. `builtin` loads `abc`
 * as a builtin ABC.
 */
export function typedErrors(builtins: Uint8Array[], abc: Uint8Array, builtin = false): number[] {
  const link = linkError(builtins, abc, builtin);
  if (link) {
    return [link];
  }

  const errors = (testing.domainVerifyAll() as string)
    .split("\n")
    .filter((l) => l.includes(" error "))
    .map((l) => Number(l.split(" ")[5]));
  return [...new Set(errors)].sort((a, b) => a - b);
}

/**
 * A problem in the IR of the methods of the ABC typedErrors last verified
 * (see domainCheckIr in codegen's testing.ts), or null if it is well formed.
 */
export function irProblem(): string | null {
  const result = testing.domainCheckIr() as string;
  return result.startsWith("checked") ? null : result;
}
