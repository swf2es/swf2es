// TypeScript declarations of the classes ABCs define: for each class, an
// interface of its instances' public members and one of its class
// object's, as natives and hosts reach them through Runtime.prop, setProp
// and callProp (docs/architecture/runtime.md, "AS3 classes in
// TypeScript"). The libraries the ABCs link against name the classes they
// extend and the types they use; what none defines is `Value`.
//
// Only type imports, so that node runs this file as it is
// (tools/as3-types.ts); the command reads the ABCs (commands/types.ts).

import type { AbcClass, AbcMethod, AbcSurface, AbcTrait } from "@swf2es/format";

/** A library the ABCs link against, whose declarations are written elsewhere. */
export interface DeclaredLibrary {
  abcs: AbcSurface[];
  /** The type its instance interfaces are keyed in by qualified name, as the output spells it. */
  classes: string;
}

export interface DeclarationsOptions {
  /** The ABCs whose classes are declared, in the order they load: the first definition of a name wins. */
  abcs: AbcSurface[];
  /** The maps' names: `${name}Classes` and `${name}Statics`. */
  name: string;
  /** What the ABCs link against, in the order they load, before the ABCs. */
  libraries: DeclaredLibrary[];
  /** The comment the output starts with, without its `// ` prefixes. */
  header: string[];
  /** The import declarations the output needs for `ref`, `value` and the libraries' maps. */
  imports: string[];
  /** How the output spells @swf2es/runtime's avm2 Ref and Value types. */
  ref: string;
  value: string;
  /** Parameter names for a method whose ABC has none, by its class's qualified name and its own. */
  paramNames?: (qualified: string, method: string) => string[] | undefined;
}

/** A name's namespace kind and URI, and its local name. */
interface Name {
  kind: string;
  uri: string;
  local: string;
}

/** A name as the surface spells it ("Array", "flash.geom::Point", "{package:@v0}::uint"), taken apart. */
function parseName(raw: string): Name {
  if (raw.startsWith("{")) {
    const end = raw.lastIndexOf("}::");
    // One namespace, or the same one in several API versions: the first's kind and URI.
    const ns = raw.slice(1, end).split(",")[0];
    const colon = ns.indexOf(":");
    const kind = colon < 0 ? ns : ns.slice(0, colon);
    return {
      kind: kind.replace(/#\d+$/, ""),
      uri: (colon < 0 ? "" : ns.slice(colon + 1)).replace(/@v\d+$/, ""),
      local: raw.slice(end + 3),
    };
  }

  const at = raw.lastIndexOf("::");
  return {
    kind: "package",
    uri: at < 0 ? "" : raw.slice(0, at),
    local: at < 0 ? raw : raw.slice(at + 2),
  };
}

/**
 * A class's qualified name, "flash.geom::Rectangle" or a top-level
 * "Array", or null for one no other ABC can name; the builtin's Vector
 * classes, internal to __AS3__.vec, as the types of Vectors.
 */
function classKey(raw: string): string | null {
  const n = parseName(raw);
  if (n.kind === "package" || (n.kind === "internal" && n.uri === "__AS3__.vec")) {
    return n.uri ? `${n.uri}::${n.local}` : n.local;
  }

  return null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Words a parameter may not be named. */
const RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export " +
    "extends false finally for function if implements import in instanceof interface let " +
    "new null package private protected public return static super switch this throw true " +
    "try typeof var void while with yield await arguments eval"
  ).split(" "),
);

function memberName(local: string): string {
  return IDENTIFIER.test(local) && local !== "constructor" ? local : JSON.stringify(local);
}

/** A class's public members, by local name: what a property or a method declares. */
type Member =
  | { kind: "property"; type: string; readable: boolean; writable: boolean; constant: boolean }
  | { kind: "method"; method: AbcMethod };

interface Definition {
  key: string;
  cls: AbcClass;
  /** Whether the output declares it, rather than a library's. */
  own: boolean;
  /** The library whose map declares it, if not own. */
  library?: DeclaredLibrary;
}

/** The public members of `traits`, a getter and a setter of one name as one property. */
function membersOf(traits: AbcTrait[], isInterface: boolean): Map<string, Member> {
  const out = new Map<string, Member>();
  for (const t of traits) {
    const n = parseName(t.name);
    // An interface's methods are in its own namespace, and public in each class that implements it.
    if (n.kind !== "package" && !(isInterface && n.kind === "namespace")) {
      continue;
    }

    switch (t.kind) {
      case "slot":
      case "const":
        out.set(n.local, {
          kind: "property",
          type: t.type,
          readable: true,
          writable: t.kind === "slot",
          constant: t.kind === "const",
        });
        break;
      case "getter":
      case "setter": {
        const had = out.get(n.local);
        const type = t.kind === "getter" ? t.method.returns : (t.method.params[0]?.type ?? "*");
        const was = had?.kind === "property" ? had : null;
        out.set(n.local, {
          kind: "property",
          type: t.kind === "getter" || !was ? type : was.type,
          readable: t.kind === "getter" || (was?.readable ?? false),
          writable: t.kind === "setter" || (was?.writable ?? false),
          constant: false,
        });
        break;
      }
      case "method":
        out.set(n.local, { kind: "method", method: t.method });
        break;
    }
  }

  return out;
}

/** The declarations of the classes `options.abcs` define, as a TypeScript module. */
export function as3Declarations(options: DeclarationsOptions): string {
  const { ref, value } = options;
  const definitions = new Map<string, Definition>();
  const define = (abcs: AbcSurface[], own: boolean, library?: DeclaredLibrary) => {
    for (const abc of abcs) {
      for (const script of abc.scripts) {
        for (const t of script.traits) {
          const key = t.kind === "class" ? classKey(t.name) : null;
          if (t.kind === "class" && key !== null && !definitions.has(key)) {
            definitions.set(key, { key, cls: t.class, own, library });
          }
        }
      }
    }
  };
  for (const library of options.libraries) {
    define(library.abcs, false, library);
  }

  define(options.abcs, true);

  // Each class's interface's name: its qualified name as an identifier,
  // "As3_flash_geom_Rectangle", and its class object's with a $ after it,
  // told apart by a number where two would meet.
  const keys = [...definitions.keys()].sort();
  const identifiers = new Map<string, string>();
  const taken = new Set<string>();
  for (const key of keys) {
    const base = `As3_${key.replace(/::|\./g, "_").replace(/[^\w$]/g, "_")}`;
    let id = base;
    for (let i = 2; taken.has(id) || taken.has(`${id}$`); i++) {
      id = `${base}_${i}`;
    }

    taken.add(id);
    taken.add(`${id}$`);
    identifiers.set(key, id);
  }

  // The libraries' classes the output names, each by an alias of its map's entry.
  const used = new Set<string>();
  const named = (key: string): string => {
    const d = definitions.get(key) as Definition;
    if (!d.own) {
      used.add(key);
    }

    return identifiers.get(key) as string;
  };

  const tsType = (raw: string): string => {
    if (raw === "*") {
      return value;
    }

    if (raw === "void") {
      return "void";
    }

    const vector = raw.match(/^(.*?)\.<(.*)>$/);
    if (vector) {
      const element = classKey(vector[2]);
      const store =
        element === "int" || element === "uint"
          ? element
          : element === "Number"
            ? "double"
            : "object";
      const key = `__AS3__.vec::Vector$${store}`;
      return definitions.has(key) ? `${ref}<${named(key)}> | null` : value;
    }

    const key = classKey(raw);
    switch (key) {
      case "int":
      case "uint":
      case "Number":
      case "float":
        return "number";
      case "void":
        return "void";
      case "Boolean":
        return "boolean";
      case "String":
        return "string | null";
      case "Object":
      case null:
        return value;
    }

    return definitions.has(key) ? `${ref}<${named(key)}> | null` : value;
  };

  // What each class declares, its bases' included, for telling an override from a new member.
  const declared = new Map<string, Map<string, Member>>();
  const allMembers = (key: string, seen: Set<string> = new Set()): Map<string, Member> => {
    const known = declared.get(key);
    if (known) {
      return known;
    }

    const all = new Map<string, Member>();
    const d = definitions.get(key);
    if (d && !seen.has(key)) {
      seen.add(key);
      const isInterface = d.cls.flags.includes("interface");
      const bases = isInterface ? d.cls.interfaces : d.cls.super ? [d.cls.super] : [];
      for (const base of bases) {
        const b = classKey(base);
        if (b !== null) {
          for (const [name, m] of allMembers(b, seen)) {
            all.set(name, m);
          }
        }
      }

      for (const [name, m] of membersOf(d.cls.instance, isInterface)) {
        const had = all.get(name);
        // An accessor's override may declare one half alone: the other is still the base's.
        if (m.kind === "property" && had?.kind === "property" && !m.constant) {
          all.set(name, {
            ...had,
            readable: m.readable || had.readable,
            writable: m.writable || had.writable,
          });
        } else {
          all.set(name, m);
        }
      }
    }

    declared.set(key, all);
    return all;
  };

  const params = (key: string, member: string, m: AbcMethod): string => {
    const names = options.paramNames?.(key, member);
    const seen = new Set<string>();
    const name = (i: number, given: string | undefined) => {
      const n = given ?? names?.[i];
      const ok = n !== undefined && IDENTIFIER.test(n) && !RESERVED.has(n) && !seen.has(n);
      const out = ok ? n : `arg${i}`;
      seen.add(out);
      return out;
    };
    const list = m.params.map(
      (p, i) => `${name(i, p.name)}${p.default ? "?" : ""}: ${tsType(p.type)}`,
    );
    if (m.flags.includes("rest")) {
      const rest = names?.[m.params.length];
      const n = rest && IDENTIFIER.test(rest) && !RESERVED.has(rest) ? rest : "rest";
      list.push(`...${seen.has(n) ? "rest" : n}: ${value}[]`);
    }

    return list.join(", ");
  };

  const memberLines = (key: string, members: Map<string, Member>): string[] => {
    const lines: string[] = [];
    for (const name of [...members.keys()].sort()) {
      const m = members.get(name) as Member;
      if (m.kind === "method") {
        lines.push(
          `  ${memberName(name)}(${params(key, name, m.method)}): ${tsType(m.method.returns)};`,
        );
        continue;
      }

      if (!m.readable) {
        lines.push("  /** Write-only: reading it throws, as in AS3. */");
      }

      lines.push(`  ${m.writable ? "" : "readonly "}${memberName(name)}: ${tsType(m.type)};`);
    }

    return lines;
  };

  const block = (head: string, lines: string[]) =>
    lines.length ? [`${head} {`, ...lines, "}"] : [`${head} {}`];

  const body: string[] = [];
  const own = keys.filter((k) => (definitions.get(k) as Definition).own);
  for (const key of own) {
    const d = definitions.get(key) as Definition;
    const id = identifiers.get(key) as string;
    const isInterface = d.cls.flags.includes("interface");
    const bases = (isInterface ? d.cls.interfaces : d.cls.super ? [d.cls.super] : [])
      .map(classKey)
      .filter((b): b is string => b !== null && definitions.has(b));
    const inherited = new Map<string, Member>();
    for (const b of bases) {
      for (const [name, m] of allMembers(b)) {
        inherited.set(name, m);
      }
    }

    // A member a base declares stays the base's, but for an accessor this class makes writable.
    const mine = new Map<string, Member>();
    for (const [name, m] of allMembers(key)) {
      const had = inherited.get(name);
      if (
        had === undefined ||
        (had.kind === "property" && m.kind === "property" && m.writable && !had.writable)
      ) {
        mine.set(name, m);
      }
    }

    body.push(
      "",
      ...block(
        `export interface ${id}${bases.length ? ` extends ${bases.map(named).join(", ")}` : ""}`,
        memberLines(key, mine),
      ),
      "",
      ...block(`export interface ${id}$`, memberLines(key, membersOf(d.cls.static, false))),
    );
  }

  const aliases: string[] = [];
  for (const key of [...used].sort()) {
    const library = (definitions.get(key) as Definition).library as DeclaredLibrary;
    aliases.push(`type ${identifiers.get(key)} = ${library.classes}[${JSON.stringify(key)}];`);
  }

  const map = (suffix: string) =>
    own.map((k) => `  ${JSON.stringify(k)}: ${identifiers.get(k)}${suffix};`);
  return [
    ...options.header.map((line) => (line ? `// ${line}` : "//")),
    "",
    ...options.imports,
    ...(aliases.length ? ["", ...aliases] : []),
    "",
    "/** Each class's instances' public members, by the class's qualified name. */",
    `export interface ${options.name}Classes {`,
    ...map(""),
    "}",
    "",
    "/** Each class object's public members, its static ones, by the class's qualified name. */",
    `export interface ${options.name}Statics {`,
    ...map("$"),
    "}",
    ...body,
    "",
  ].join("\n");
}
