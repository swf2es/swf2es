// builtin's thunks (packages/runtime/src/avm2/builtin/thunks.ts), from its
// declarations: for each native whose arguments need defaults or coercing,
// a function of its own that gives them and calls the native, as avmplus'
// nativegen.py writes a thunk for each of its natives. Each is its own
// function, so that it calls one native only and the engine can inline it,
// which one function shared by every native could not.
//
//   node tools/thunks.ts           write thunks.ts, after pnpm build
//
// A unit test holds the file to the declarations; regenerate after
// changing them, and build again.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NativeMember } from "../packages/runtime/dist/avm2/builtin/bind.js";
import type {
  ClassDecl,
  MethodDecl,
  ScriptDecl,
  Value,
} from "../packages/runtime/dist/avm2/builtin/declare.js";

const root = fileURLToPath(new URL("../", import.meta.url));
export const THUNKS = `${root}packages/runtime/src/avm2/builtin/thunks.ts`;

/** A number as a JavaScript literal: NaN, the infinities and -0 by name. */
function numberLiteral(n: number): string {
  if (Number.isNaN(n)) {
    return "Number.NaN";
  }

  if (!Number.isFinite(n)) {
    return n > 0 ? "Number.POSITIVE_INFINITY" : "Number.NEGATIVE_INFINITY";
  }

  return Object.is(n, -0) ? "-0" : String(n);
}

/** A constant as a number, as AS3's ToNumber makes it. */
function toNumber(v: Value): number {
  switch (v[0]) {
    case "undefined":
      return Number.NaN;
    case "null":
      return 0;
    case "boolean":
      return v[1] ? 1 : 0;
    case "string":
      return v[1].trim() === "" ? 0 : Number(v[1]);
    case "namespace":
      throw new Error(`a namespace default, ${v[1]}, as a number`);
    default:
      return Number(v[1]);
  }
}

/** A default `v` coerced to parameter type `type`, as a JavaScript literal. */
function defaultLiteral(v: Value, type: string): string {
  switch (type) {
    case "int":
      return numberLiteral(toNumber(v) | 0);
    case "uint":
      return numberLiteral(toNumber(v) >>> 0);
    case "Number":
      return numberLiteral(toNumber(v));
    case "Boolean":
      return String(
        v[0] === "string" ? v[1] !== "" : Boolean(v[0] === "double" ? toNumber(v) : v[1]),
      );
    case "String":
      if (v[0] === "undefined" || v[0] === "null") {
        return "null";
      }

      if (v[0] === "string") {
        return JSON.stringify(v[1]);
      }

      throw new Error(`a ${v[0]} default for a String`);
  }

  switch (v[0]) {
    case "undefined":
      return type === "*" ? "undefined" : "null";
    case "null":
      return "null";
    case "boolean":
      return String(v[1]);
    case "string":
      return JSON.stringify(v[1]);
    case "namespace":
      throw new Error(`a namespace default, ${v[1]}`);
    default:
      return numberLiteral(toNumber(v));
  }
}

/**
 * A class type as a thunk names it: a reference made once, which coerceTo
 * keeps the class's traits on, as compiled code's coercions do.
 */
function classRef(type: string, refs: string[]): string {
  // A top-level class, in the unnamed package.
  if (!type.includes("::")) {
    const name = `r${refs.length}`;
    refs.push(`const ${name} = rt.cls(namespace(NS_Public, ""), ${JSON.stringify(type)});`);
    return name;
  }

  const m = type.match(
    /^(?:\{(internal|package):([^}@]*)(?:@v\d+)?\}|([^{}:]+|internal:[^{}]*))::([\w$]+)$/,
  );
  if (!m) {
    throw new Error(`a parameter of type ${type}`);
  }

  const internal = m[1] === "internal" || m[3]?.startsWith("internal:");
  const pkg = m[2] ?? (m[3]?.startsWith("internal:") ? m[3].slice("internal:".length) : m[3]);
  const ns = `namespace(${internal ? "NS_PackageInternal" : "NS_Public"}, ${JSON.stringify(pkg)})`;
  const name = `r${refs.length}`;
  refs.push(`const ${name} = rt.cls(${ns}, ${JSON.stringify(m[4])});`);
  return name;
}

/** Argument `a` coerced to `type`, as an expression. */
function coerced(a: string, type: string, refs: string[]): string {
  switch (type) {
    case "*":
      return a;
    case "int":
      return `rt.toInt(${a})`;
    case "uint":
      return `rt.toUint(${a})`;
    case "Number":
      return `rt.toNumber(${a})`;
    case "Boolean":
      return `!!${a}`;
    case "String":
      return `rt.coerceString(${a})`;
    case "Object":
      return `rt.coerceObject(${a})`;
    default:
      return `rt.coerceTo(${a}, ${classRef(type, refs)})`;
  }
}

/** The thunk of native `d`, as source, or null where it needs none. */
export function thunkOf(d: MethodDecl): string | null {
  const params = d.params ?? [];
  const types = params.map((p) => (typeof p === "string" ? p : p[0]));
  const defaults = params.map((p) => (typeof p === "string" ? null : p[1]));
  const anyDefault = defaults.some((v) => v !== null);
  // One whose AS3 reads `arguments` gets them as given.
  if (d.arguments || (!anyDefault && types.every((t) => t === "*"))) {
    return null;
  }

  const refs: string[] = [];
  const names = params.map((_, i) => `a${i}`);
  const args = names.map((a, i) => {
    const value = coerced(a, types[i], refs);
    const v = defaults[i];
    return v === null ? value : `n > ${i} ? ${value} : ${defaultLiteral(v, types[i])}`;
  });
  const signature = [...names.map((a) => `${a}: Value`), ...(d.rest ? ["...rest: Value[]"] : [])];
  const passed = [...args, ...(d.rest ? ["...rest"] : [])];
  const body = [
    ...(anyDefault ? ["const n = arguments.length;"] : []),
    `return f.call(this, ${passed.join(", ")});`,
  ];
  const fn = `function (this: AsObject, ${signature.join(", ")}) {\n${body.join("\n")}\n}`;
  const usesRt = refs.length > 0 || passed.some((p) => p.includes("rt."));
  const rt = usesRt ? "rt" : "_rt";
  return refs.length
    ? `(${rt}, f) => {\n${refs.join("\n")}\nreturn ${fn};\n}`
    : `(${rt}, f) => ${fn}`;
}

/** thunks.ts, for the classes the scripts declare. */
export function generate(
  scripts: readonly ScriptDecl[],
  nativeMembers: (decl: ClassDecl, bodies: boolean) => NativeMember[],
): string {
  const entries: [string, string][] = [];
  for (const script of scripts) {
    for (const t of script.traits) {
      if (!("class" in t)) {
        continue;
      }

      for (const { key, decl } of nativeMembers(t.class, true)) {
        const thunk = thunkOf(decl);
        if (thunk) {
          entries.push([key, thunk]);
        }
      }
    }
  }

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const used = ["NS_PackageInternal", "NS_Public", "namespace"].filter((name) =>
    entries.some(([, t]) => t.includes(`${name}`)),
  );
  return [
    "// Generated by tools/thunks.ts from the declarations: regenerate, do not edit.",
    "// Each native whose arguments need defaults or coercing, by its key, called",
    "// through a function of its own (see tools/thunks.ts and bind.ts).",
    "",
    'import type { AsObject, Method, Value } from "../descriptors.js";',
    ...(used.length ? [`import { ${used.join(", ")} } from "../names.js";`] : []),
    'import type { Runtime } from "../runtime.js";',
    "",
    "export const thunks: Record<string, (rt: Runtime, f: Method) => Method> = {",
    ...entries.map(([key, thunk]) => `${JSON.stringify(key)}: ${thunk},`),
    "};",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { scripts } = await import("../packages/runtime/dist/avm2/builtin/scripts.js");
  const { nativeMembers } = await import("../packages/runtime/dist/avm2/builtin/bind.js");
  writeFileSync(THUNKS, generate(scripts, nativeMembers));
  execFileSync(`${root}node_modules/.bin/biome`, ["check", "--write", THUNKS], {
    stdio: "inherit",
  });
  console.log(`wrote ${THUNKS.slice(root.length)}`);
}
