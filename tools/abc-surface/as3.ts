// AS3 skeletons of an ABC's public API: for each public definition of a
// library such as playerglobal.abc, an .as file that declares it as the
// ABC does, every method `native` and every constructor empty, its
// implementation still to be written. Only public and protected names are
// written: private and internal ones are the library's own.
//
//   node tools/abc-surface/as3.ts playerglobal.abc out-dir [package prefix...] [--names dir]
//
// writes into out-dir, which must be new or empty, the definitions in the
// packages given (all by default). --names takes parameter names from .as
// sources under dir, laid out by package, such as Ruffle's, for the
// methods they declare: the ABC has none.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Class, type Method, readSurface, type Trait, type Value } from "./read.ts";

/** A name taken apart: its namespace's kind and URI, its API version, its local name. */
interface Name {
  kind: string;
  uri: string;
  /** The API versions it is in, by their offset from 660 (Flash Player 9's), ascending. */
  apis: number[];
  local: string;
}

function parseName(raw: string): Name {
  if (raw.startsWith("{")) {
    const end = raw.lastIndexOf("}::");
    const local = raw.slice(end + 3);
    // One namespace, or the same one in several API versions (Flash
    // Player's and AIR's): the first version it is in.
    const all = raw
      .slice(1, end)
      .split(",")
      .map((ns) => {
        const colon = ns.indexOf(":");
        const kind = colon < 0 ? ns : ns.slice(0, colon);
        const rest = colon < 0 ? "" : ns.slice(colon + 1);
        const m = rest.match(/^(.*)@v(\d+)$/);
        return {
          kind: kind.startsWith("private#") ? "private" : kind,
          uri: m ? m[1] : rest,
          apis: m ? [Number(m[2])] : [],
          local,
        };
      });
    if (all.some((n) => n.kind !== all[0].kind || n.uri !== all[0].uri)) {
      throw new Error(`${raw}: a name in different namespaces`);
    }

    return { ...all[0], apis: all.flatMap((n) => n.apis).sort((a, b) => a - b) };
  }

  const at = raw.lastIndexOf("::");
  return {
    kind: "package",
    uri: at < 0 ? "" : raw.slice(0, at),
    apis: [],
    local: at < 0 ? raw : raw.slice(at + 2),
  };
}

/** A type as the source writes it, the package it needs imported added to `imports`. */
function typeName(type: string, pkg: string, imports: Set<string>): string {
  if (type === "*" || type === "void") {
    return type;
  }

  const vector = type.match(/^(.*?)\.<(.*)>$/);
  if (vector) {
    return `Vector.<${typeName(vector[2], pkg, imports)}>`;
  }

  const n = parseName(type);
  if (n.uri && n.uri !== pkg && n.uri !== "__AS3__.vec") {
    imports.add(`${n.uri}.${n.local}`);
  }

  return n.local;
}

function literal(v: Value): string {
  switch (v[0]) {
    case "undefined":
      return "undefined";
    case "null":
      return "null";
    case "string":
      return JSON.stringify(v[1]);
    case "boolean":
      return String(v[1]);
    case "namespace":
      throw new Error(`a namespace constant, ${v[1]}`);
    default: {
      const n = Number(v[1]);
      if (Number.isNaN(n)) {
        return "NaN";
      }

      if (!Number.isFinite(n)) {
        return n > 0 ? "Infinity" : "-Infinity";
      }

      return String(n);
    }
  }
}

/**
 * The metadata worth keeping in source: the API versions a name is in,
 * which the compiler marks it with, as [API(...)] has them or else as the
 * name's marks have them (the ABC keeps few of its [API]s). Flash Player
 * 9's, 660, is every unmarked name's: the build marks those so. Adobe's
 * [native(...)] is its binding's own.
 */
function metadata(
  trait: { name?: string; meta?: [string, [string, string][]][] },
  indent: string,
): string {
  const api = (trait.meta ?? []).find(([name]) => name === "API");
  const versions = api
    ? api[1].map(([, v]) => v)
    : trait.name
      ? parseName(trait.name)
          .apis.filter((v) => v > 0)
          .map((v) => String(660 + v))
      : [];
  return versions.length
    ? `${indent}[API(${versions.map((v) => JSON.stringify(v)).join(", ")})]\n`
    : "";
}

/** The access a name is written with, or null for one the skeleton leaves out. */
function access(n: Name): string | null {
  switch (n.kind) {
    case "package":
      return "public";
    case "protected":
    case "staticprotected":
      return "protected";
    default:
      return null;
  }
}

/** Parameter names from another source tree's declarations, by "Class.method" or "function". */
function namesFrom(dir: string | null, pkg: string, local: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!dir) {
    return out;
  }

  const file = join(dir, ...pkg.split("."), `${local}.as`);
  if (!existsSync(file)) {
    return out;
  }

  const text = readFileSync(file, "utf8");
  const fn = /function\s+(?:(get|set)\s+)?([\w$]+)\s*\(([^)]*)\)/g;
  for (let m = fn.exec(text); m; m = fn.exec(text)) {
    const params = m[3]
      .split(",")
      .map(
        (p) =>
          p
            .trim()
            .replace(/^\.\.\./, "")
            .split(/[:=\s]/)[0],
      )
      .filter(Boolean);
    out.set(`${m[1] ?? ""}${m[2]}`, params);
  }

  return out;
}

function params(m: Method, pkg: string, imports: Set<string>, named: string[] | undefined): string {
  const out = m.params.map((p, i) => {
    const name = named?.[i] ?? `arg${i}`;
    const d = p.default ? ` = ${literal(p.default)}` : "";
    return `${name}:${typeName(p.type, pkg, imports)}${d}`;
  });
  if (m.flags.includes("rest")) {
    out.push(`...${named?.[m.params.length] ?? "rest"}`);
  }

  return out.join(", ");
}

function member(
  t: Trait,
  isStatic: boolean,
  pkg: string,
  imports: Set<string>,
  names: Map<string, string[]>,
  isInterface: boolean,
): string | null {
  const n = parseName(t.name);
  const acc = access(n);
  if (!acc) {
    return null;
  }

  const meta = metadata(t, "        ");
  const mods = isInterface ? "" : `${acc} ${isStatic ? "static " : ""}`;
  switch (t.kind) {
    case "slot":
    case "const": {
      const value = t.value ? ` = ${literal(t.value)}` : "";
      const kw = t.kind === "slot" ? "var" : "const";
      return `${meta}        ${mods}${kw} ${n.local}:${typeName(t.type, pkg, imports)}${value};`;
    }
    case "method":
    case "getter":
    case "setter": {
      const acc2 = t.kind === "getter" ? "get " : t.kind === "setter" ? "set " : "";
      const flags = isInterface
        ? ""
        : `${t.flags.includes("override") ? "override " : ""}${t.flags.includes("final") && !isStatic ? "final " : ""}`;
      const native = isInterface ? "" : "native ";
      const named = names.get(`${acc2.trim()}${n.local}`);
      const ret = typeName(t.method.returns, pkg, imports);
      return `${meta}        ${flags}${mods}${native}function ${acc2}${n.local}(${params(t.method, pkg, imports, named)}):${ret};`;
    }
    default:
      return null;
  }
}

function classSource(c: Class, raw: string, meta: Trait["meta"], namesDir: string | null): string {
  const n = parseName(raw);
  const pkg = n.uri;
  const imports = new Set<string>();
  const names = namesFrom(namesDir, pkg, n.local);
  const isInterface = c.flags.includes("interface");
  const lines: string[] = [];
  for (const [isStatic, list] of [
    [true, c.static],
    [false, c.instance],
  ] as const) {
    for (const t of list) {
      const m = member(t, isStatic, pkg, imports, names, isInterface);
      if (m) {
        lines.push(m);
      }
    }
  }

  const base = c.super && c.super !== "Object" ? typeName(c.super, pkg, imports) : null;
  const ifaces = c.interfaces.map((i) =>
    typeName(
      i.replace(/^\{[^}]*\}::/, (s) => s),
      pkg,
      imports,
    ),
  );
  const decl = isInterface
    ? `public interface ${n.local}${ifaces.length ? ` extends ${ifaces.join(", ")}` : ""}`
    : `public ${c.flags.includes("final") ? "final " : ""}${c.flags.includes("sealed") ? "" : "dynamic "}class ${n.local}${base ? ` extends ${base}` : ""}${ifaces.length ? ` implements ${ifaces.join(", ")}` : ""}`;
  const ctor = isInterface
    ? []
    : [
        `        public function ${n.local}(${params(c.init, pkg, imports, names.get(n.local))}) {`,
        "        }",
      ];
  const body = [...ctor, ...(ctor.length && lines.length ? [""] : []), ...lines];
  return [
    `package ${pkg} {`,
    ...[...imports].sort().map((i) => `    import ${i};`),
    ...(imports.size ? [""] : []),
    `${metadata({ name: raw, meta }, "    ")}    ${decl} {`,
    ...body,
    "    }",
    "}",
    "",
  ].join("\n");
}

/** A package-level function, constant or variable, as a file of its own. */
function definitionSource(t: Trait, namesDir: string | null): string | null {
  const n = parseName(t.name);
  if (access(n) !== "public") {
    return null;
  }

  const imports = new Set<string>();
  const names = namesFrom(namesDir, n.uri, n.local);
  let decl: string;
  switch (t.kind) {
    case "slot":
    case "const": {
      const value = t.value ? ` = ${literal(t.value)}` : "";
      decl = `    public ${t.kind === "slot" ? "var" : "const"} ${n.local}:${typeName(t.type, n.uri, imports)}${value};`;
      break;
    }
    case "method":
    case "function": {
      const m = t.method;
      decl = `    public native function ${n.local}(${params(m, n.uri, imports, names.get(n.local))}):${typeName(m.returns, n.uri, imports)};`;
      break;
    }
    default:
      return null;
  }

  return [
    `package ${n.uri} {`,
    ...[...imports].sort().map((i) => `    import ${i};`),
    ...(imports.size ? [""] : []),
    `${metadata(t, "    ")}${decl}`,
    "}",
    "",
  ].join("\n");
}

/** Each public definition of the ABC `bytes` in packages starting with `prefixes`, as [path, source]. */
export function skeletons(
  bytes: Uint8Array,
  prefixes: string[],
  namesDir: string | null,
): [string, string][] {
  const surface = readSurface(bytes);
  const out: [string, string][] = [];
  const wanted = (pkg: string) =>
    prefixes.length === 0 || prefixes.some((p) => pkg === p || pkg.startsWith(`${p}.`));
  for (const script of surface.scripts) {
    for (const t of script.traits) {
      const n = parseName(t.name);
      if (n.kind !== "package" || !wanted(n.uri)) {
        continue;
      }

      const source =
        t.kind === "class"
          ? classSource(t.class, t.name, t.meta, namesDir)
          : definitionSource(t, namesDir);
      if (source) {
        out.push([join(...n.uri.split("."), `${n.local}.as`), source]);
      }
    }
  }

  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const namesAt = args.indexOf("--names");
  const namesDir = namesAt >= 0 ? args[namesAt + 1] : null;
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && (namesAt < 0 || i !== namesAt + 1),
  );
  const [abc, out, ...prefixes] = positional;
  if (!abc || !out) {
    console.error(
      "usage: node tools/abc-surface/as3.ts lib.abc out-dir [package...] [--names dir]",
    );
    process.exit(2);
  }

  if (existsSync(out) && readdirSync(out).length > 0) {
    console.error(`${out} is not empty: write the skeletons into a new folder and compare`);
    process.exit(1);
  }

  const files = skeletons(readFileSync(abc), prefixes, namesDir);
  for (const [path, source] of files) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), source);
  }

  console.log(`${files.length} files in ${out}`);
}
