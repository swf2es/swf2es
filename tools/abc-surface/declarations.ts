// Builtin's declarations (packages/runtime/src/avm2/builtin/declare.ts)
// from an ABC's surface, as TypeScript, and the surface back from them, so
// a test can hold the declarations to the ABC they began as.
//
//   node tools/abc-surface/declarations.ts builtin.abc [out dir]
//
// writes one file per class under the out dir (by default the runtime's
// declarations/) and scripts.ts, which lists the scripts in order.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClassDecl,
  MethodDecl,
  Param,
  ScriptDecl,
  TraitDecl,
  Value,
} from "../../packages/runtime/src/avm2/builtin/declare.ts";
import { type Class, type Method, readSurface, type Surface, type Trait } from "./read.ts";

const AS3 = "http://adobe.com/AS3/2006/builtin";
const FLASH_PROXY = "http://www.adobe.com/2006/actionscript/flash/proxy";

/** A surface name taken apart: its namespace as read.ts writes it, and its local name. */
function split(raw: string): { ns: string; local: string } {
  if (raw.startsWith("{")) {
    const end = raw.lastIndexOf("}::");
    const set = raw.slice(1, end);
    if (set.includes(",")) {
      throw new Error(`${raw}: a name with more than one namespace`);
    }

    return { ns: set, local: raw.slice(end + 3) };
  }

  const at = raw.lastIndexOf("::");
  return at < 0
    ? { ns: "package:", local: raw }
    : { ns: `package:${raw.slice(0, at)}`, local: raw.slice(at + 2) };
}

/** What a name's private, protected and internal namespaces are relative to. */
interface Owner {
  /** The private namespace's number and URI, once a name in it is seen. */
  private?: string;
  privateUri?: string;
  /** Its package, for internal names; undefined for a script, whose names give theirs. */
  pkg?: string;
  /** Its protected namespace's URI. */
  protected?: string;
}

/** A trait's or class's name as declared, and its API version. */
function declName(raw: string, owner: Owner): [string, number | undefined] {
  const { ns, local } = split(raw);
  const colon = ns.indexOf(":");
  const kind = colon < 0 ? ns : ns.slice(0, colon);
  const uri = colon < 0 ? "" : ns.slice(colon + 1);
  switch (kind) {
    case "package": {
      const m = uri.match(/^(.*)@v(\d+)$/);
      if (!m) {
        throw new Error(`${raw}: a public name without an API version`);
      }

      const api = Number(m[2]);
      return [m[1] ? `${m[1]}::${local}` : local, api === 0 ? undefined : api];
    }
    case "namespace":
      if (uri === AS3) {
        return [`AS3::${local}`, undefined];
      }

      if (uri === FLASH_PROXY) {
        return [`flash_proxy::${local}`, undefined];
      }

      return [`ns:${uri}::${local}`, undefined];
    case "internal":
      return [uri === owner.pkg ? `internal::${local}` : `internal:${uri}::${local}`, undefined];
    case "protected":
    case "staticprotected":
      if (uri !== owner.protected) {
        throw new Error(`${raw}: another class's protected namespace`);
      }

      return [`${kind}::${local}`, undefined];
    default:
      if (kind.startsWith("private#")) {
        owner.private ??= kind;
        owner.privateUri ??= uri;
        if (owner.private !== kind) {
          throw new Error(`${raw}: a second private namespace in one class or script`);
        }

        return [`private::${local}`, undefined];
      }

      throw new Error(`${raw}: namespace ${ns}`);
  }
}

/** The surface name of a declared one, its private namespace named after `ownerKey`. */
function rawName(name: string, api: number | undefined, owner: Owner, ownerKey: string): string {
  const at = name.lastIndexOf("::");
  const prefix = at < 0 ? "" : name.slice(0, at);
  const local = at < 0 ? name : name.slice(at + 2);
  const one = (ns: string) => `{${ns}}::${local}`;
  switch (prefix) {
    case "AS3":
      return one(`namespace:${AS3}`);
    case "flash_proxy":
      return one(`namespace:${FLASH_PROXY}`);
    case "private":
      return one(`private#${ownerKey}:${owner.privateUri}`);
    case "internal":
      return one(`internal:${owner.pkg}`);
    case "protected":
    case "staticprotected":
      return one(`${prefix}:${owner.protected}`);
  }

  if (prefix.startsWith("ns:")) {
    return one(`namespace:${prefix.slice(3)}`);
  }

  if (prefix.startsWith("internal:")) {
    return one(prefix);
  }

  return one(`package:${prefix}@v${api ?? 0}`);
}

/** A class's package, from its declared name. */
function packageOf(name: string): string {
  const at = name.lastIndexOf("::");
  if (at < 0) {
    return "";
  }

  const prefix = name.slice(0, at);
  if (prefix === "private" || prefix === "internal") {
    return "";
  }

  return prefix.startsWith("internal:") ? prefix.slice("internal:".length) : prefix;
}

function localOf(name: string): string {
  const at = name.lastIndexOf("::");
  return at < 0 ? name : name.slice(at + 2);
}

/** A class's protected namespace's URI unless its declaration says otherwise. */
function defaultProtected(name: string): string {
  const pkg = packageOf(name);
  return pkg ? `${pkg}:${localOf(name)}` : localOf(name);
}

/** The class a multiname such as an interface list's names, by its surface name. */
function resolver(surface: Surface): (raw: string) => string {
  const classes = new Map<string, string[]>();
  const visit = (traits: Trait[]) => {
    for (const t of traits) {
      if (t.kind === "class") {
        const { ns, local } = split(t.name);
        classes.set(local, [...(classes.get(local) ?? []), ns]);
      }
    }
  };
  for (const s of surface.scripts) {
    visit(s.traits);
  }

  return (raw) => {
    if (!raw.startsWith("{")) {
      return raw;
    }

    const end = raw.lastIndexOf("}::");
    const set = raw.slice(1, end).split(",");
    const local = raw.slice(end + 3);
    // As a domain finds it: the namespace a definition has that is in the set.
    const found = (classes.get(local) ?? []).filter((ns) =>
      set.some((s) => s === ns || ns.startsWith(`${s}@v`)),
    );
    if (found.length !== 1) {
      throw new Error(`${raw}: names ${found.length} classes`);
    }

    return `{${found[0]}}::${local}`;
  };
}

function methodDecl(m: Method): MethodDecl {
  const d: MethodDecl = {};
  if (m.params.length) {
    d.params = m.params.map((p): Param => (p.default ? [p.type, p.default as Value] : p.type));
  }

  if (m.returns !== "*") {
    d.returns = m.returns;
  }

  if (m.flags.includes("rest")) {
    d.rest = true;
  }

  if (m.flags.includes("arguments")) {
    d.arguments = true;
  }

  if (m.flags.includes("ignorerest")) {
    d.ignoreRest = true;
  }

  if (m.flags.includes("native")) {
    d.native = true;
  } else if (m.code !== undefined) {
    d.avmplus = true;
  }

  return d;
}

/** The declarations of the ABC whose surface is `surface`. */
export function toDeclarations(surface: Surface): ScriptDecl[] {
  const resolve = resolver(surface);

  const traits = (list: Trait[], owner: Owner): TraitDecl[] => {
    let slot = 0;
    return list.map((t) => {
      if ("slot" in t) {
        slot++;
        if (t.slot !== 0 && t.slot !== slot) {
          throw new Error(`${t.name}: slot ${t.slot}, not the next, ${slot}`);
        }
      }

      const [name, api] = declName(t.name, owner);
      const common = { ...(api !== undefined ? { api } : {}), ...(t.meta ? { meta: t.meta } : {}) };
      switch (t.kind) {
        case "slot":
        case "const": {
          const d: TraitDecl =
            t.kind === "slot" ? { var: name, ...common } : { const: name, ...common };
          if (t.type !== "*") {
            d.type = t.type;
          }

          if (t.value) {
            d.value = t.value as Value;
          }

          return d;
        }
        case "class":
          return { class: classDecl(t.class, name, api), ...(t.meta ? { meta: t.meta } : {}) };
        case "function":
          return { function: name, ...methodDecl(t.method), ...common };
        default: {
          const flags = {
            ...(t.flags.includes("final") ? { final: true as const } : {}),
            ...(t.flags.includes("override") ? { override: true as const } : {}),
          };
          const method = methodDecl(t.method);
          switch (t.kind) {
            case "method":
              return { method: name, ...flags, ...method, ...common };
            case "getter":
              return { get: name, ...flags, ...method, ...common };
            default:
              return { set: name, ...flags, ...method, ...common };
          }
        }
      }
    });
  };

  const classDecl = (c: Class, name: string, api: number | undefined): ClassDecl => {
    const pkg = packageOf(name);
    if (c.name !== (pkg ? `${pkg}::${localOf(name)}` : localOf(name)) && !c.name.startsWith("{")) {
      throw new Error(`${name}: its instance is named ${c.name}`);
    }

    const owner: Owner = { pkg, protected: c.protectedNs?.slice(c.protectedNs.indexOf(":") + 1) };
    const head: Partial<ClassDecl> = { name };
    if (api !== undefined) {
      head.api = api;
    }

    if (c.super) {
      head.super = declClassName(resolve(c.super));
    }

    if (c.interfaces.length) {
      head.interfaces = c.interfaces.map((i) => declClassName(resolve(i)));
    }

    for (const f of c.flags) {
      head[f as "sealed" | "final" | "interface"] = true;
    }

    const usual = head.interface ? undefined : defaultProtected(name);
    if (owner.protected !== usual) {
      head.protectedNs = owner.protected ?? false;
    }

    const statics = traits(c.static, owner);
    const instance = traits(c.instance, owner);
    if (owner.privateUri !== undefined && owner.privateUri !== defaultProtected(name)) {
      head.privateNs = owner.privateUri;
    }

    return {
      ...head,
      name,
      init: methodDecl(c.init),
      classInit: methodDecl(c.classInit),
      static: statics,
      instance,
    };
  };

  return surface.scripts.map((s) => {
    const owner: Owner = {};
    const declared = traits(s.traits, owner);
    return {
      ...(owner.privateUri !== undefined ? { private: owner.privateUri } : {}),
      init: methodDecl(s.init),
      traits: declared,
    };
  });
}

/** A class reference as declared: unversioned and internal names as they are, versioned ones without their version. */
function declClassName(raw: string): string {
  if (!raw.startsWith("{")) {
    return raw;
  }

  const { ns, local } = split(raw);
  if (ns.startsWith("package:")) {
    const pkg = ns.slice("package:".length).replace(/@v\d+$/, "");
    return pkg ? `${pkg}::${local}` : local;
  }

  if (ns.startsWith("internal:")) {
    return `${ns}::${local}`;
  }

  throw new Error(`${raw}: a class reference in ${ns}`);
}

// What the comparison sees of a surface: what a SWF linking against it
// sees, with private namespaces named after their owner, references to
// classes by their declared names, and each method native, implemented
// (natively or in AS3, which a port changes) or only declared.

export interface Normal {
  scripts: { init: unknown; traits: unknown[] }[];
}

function normalMethod(m: Method): unknown {
  return {
    params: m.params.map((p) => (p.default ? [p.type, p.default] : [p.type])),
    returns: m.returns,
    flags: m.flags.filter((f) => f === "rest" || f === "arguments" || f === "ignorerest"),
    implemented: m.flags.includes("native") || m.code !== undefined,
  };
}

/** `surface` as the comparison sees it. */
export function normalize(surface: Surface): Normal {
  const resolve = resolver(surface);

  // Name each private namespace after the class or script that has it.
  const privates = new Map<string, string>();
  const claim = (traits: Trait[], key: string) => {
    for (const t of traits) {
      const m = t.name.match(/^\{(private#\d+):/);
      if (m) {
        privates.set(m[1], key);
      }
    }
  };

  const name = (raw: string) =>
    raw.replace(/^\{(private#\d+):/, (_, p: string) => `{private#${privates.get(p)}:`);

  // A script's first: a class it names privately is known by that name.
  surface.scripts.forEach((s, i) => {
    claim(s.traits, `script${i}`);
  });
  for (const s of surface.scripts) {
    for (const t of s.traits) {
      if (t.kind === "class") {
        claim(t.class.instance, name(t.name));
        claim(t.class.static, name(t.name));
      }
    }
  }

  const traits = (list: Trait[]): unknown[] =>
    list.map((t) => {
      const meta = t.meta ?? [];
      switch (t.kind) {
        case "slot":
        case "const":
          return [t.kind, name(t.name), t.type, t.value ?? null, meta];
        case "class": {
          const c = t.class;
          return [
            "class",
            name(t.name),
            meta,
            {
              super: c.super ? declClassName(resolve(c.super)) : null,
              interfaces: c.interfaces.map((i) => declClassName(resolve(i))),
              flags: c.flags,
              protectedNs: c.protectedNs ?? null,
              init: normalMethod(c.init),
              classInit: normalMethod(c.classInit),
              static: traits(c.static),
              instance: traits(c.instance),
            },
          ];
        }
        case "function":
          return [t.kind, name(t.name), meta, normalMethod(t.method)];
        default:
          return [t.kind, name(t.name), meta, t.flags, normalMethod(t.method)];
      }
    });

  return {
    scripts: surface.scripts.map((s) => ({ init: normalMethod(s.init), traits: traits(s.traits) })),
  };
}

function methodNormal(d: MethodDecl): unknown {
  const flags: string[] = [];
  if (d.arguments) {
    flags.push("arguments");
  }

  if (d.rest) {
    flags.push("rest");
  }

  if (d.ignoreRest) {
    flags.push("ignorerest");
  }

  return {
    params: (d.params ?? []).map((p) => (typeof p === "string" ? [p] : p)),
    returns: d.returns ?? "*",
    flags,
    implemented: Boolean(d.native || d.avmplus),
  };
}

/** The declarations as normalize() sees the surface they declare. */
export function fromDeclarations(scripts: ScriptDecl[]): Normal {
  const traits = (list: TraitDecl[], owner: Owner, ownerKey: string): unknown[] =>
    list.map((t) => {
      const meta = t.meta ?? [];
      if ("class" in t) {
        const c = t.class;
        const key = rawName(c.name, c.api, owner, ownerKey);
        const pkg = packageOf(c.name);
        const protectedNs =
          c.protectedNs === false
            ? undefined
            : (c.protectedNs ?? (c.interface ? undefined : defaultProtected(c.name)));
        const inner: Owner = {
          pkg,
          protected: protectedNs,
          privateUri: c.privateNs ?? defaultProtected(c.name),
        };
        const flags = (["sealed", "final", "interface"] as const).filter((f) => c[f]);
        return [
          "class",
          key,
          meta,
          {
            super: c.super ?? null,
            interfaces: c.interfaces ?? [],
            flags,
            protectedNs: protectedNs === undefined ? null : `protected:${protectedNs}`,
            init: methodNormal(c.init),
            classInit: methodNormal(c.classInit),
            static: traits(c.static, inner, key),
            instance: traits(c.instance, inner, key),
          },
        ];
      }

      if ("var" in t || "const" in t) {
        const declared = "var" in t ? t.var : t.const;
        return [
          "var" in t ? "slot" : "const",
          rawName(declared, t.api, owner, ownerKey),
          t.type ?? "*",
          t.value ?? null,
          meta,
        ];
      }

      if ("function" in t) {
        return ["function", rawName(t.function, t.api, owner, ownerKey), meta, methodNormal(t)];
      }

      const [kind, declared] =
        "method" in t ? ["method", t.method] : "get" in t ? ["getter", t.get] : ["setter", t.set];
      const flags = [...(t.final ? ["final"] : []), ...(t.override ? ["override"] : [])];
      return [kind, rawName(declared, t.api, owner, ownerKey), meta, flags, methodNormal(t)];
    });

  return {
    scripts: scripts.map((s, i) => ({
      init: methodNormal(s.init),
      traits: traits(s.traits, { privateUri: s.private }, `script${i}`),
    })),
  };
}

// Writing the declarations out.

/** Where a class's declaration goes, relative to the declarations' folder. */
function fileOf(name: string): string {
  const pkg = packageOf(name);
  return join(...(pkg ? pkg.split(".") : []), `${localOf(name)}.ts`);
}

function exportOf(name: string): string {
  return `${localOf(name)}Class`;
}

/** Math's constants, written by name: the same doubles, which the linter would rather see named. */
const MATH_CONSTANTS = new Map(
  (["E", "LN10", "LN2", "LOG10E", "LOG2E", "PI", "SQRT1_2", "SQRT2"] as const).map((k) => [
    Math[k],
    `Math.${k}`,
  ]),
);

/** `v` as a TypeScript literal: keys unquoted, each element of `expand` on its own line. */
function literal(v: unknown, expand = false): string {
  if (Array.isArray(v)) {
    const items = v.map((x) => literal(x));
    return expand ? `[\n${items.map((x) => `${x},\n`).join("")}]` : `[${items.join(", ")}]`;
  }

  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v).map(([k, x]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      const many = k === "static" || k === "instance" || k === "traits";
      return `${key}: ${literal(x, many && Array.isArray(x) && x.length > 0)}`;
    });
    return `{ ${entries.join(", ")} }`;
  }

  if (typeof v === "number" && MATH_CONSTANTS.has(v)) {
    return MATH_CONSTANTS.get(v) as string;
  }

  return JSON.stringify(v);
}

/** Write `scripts` into `dir` as one file per class and scripts.ts. */
export function writeDeclarations(scripts: ScriptDecl[], dir: string): string[] {
  rmSync(dir, { recursive: true, force: true });
  const written: string[] = [];
  const imports: string[] = [];
  const declare = join(dir, "..", "declare.js");

  const scriptTraits = (s: ScriptDecl) =>
    s.traits.map((t) => {
      if (!("class" in t)) {
        return literal(t);
      }

      const file = fileOf(t.class.name);
      const path = join(dir, file);
      const specifier = (from: string) => {
        const r = relative(dirname(from), declare);
        return r.startsWith(".") ? r : `./${r}`;
      };
      mkdirSync(dirname(path), { recursive: true });
      const { name } = t.class;
      writeFileSync(
        path,
        `import type { ClassDecl } from "${specifier(path)}";\n\n` +
          `export const ${exportOf(name)}: ClassDecl = ${literal(t.class)};\n`,
      );
      written.push(path);
      imports.push(`import { ${exportOf(name)} } from "./${file.replace(/\.ts$/, ".js")}";`);
      const { class: _, ...rest } = t;
      const extra = Object.keys(rest).length ? `, ${literal(rest).slice(2, -2)}` : "";
      return `{ class: ${exportOf(name)}${extra} }`;
    });

  const bodies = scripts.map(
    (s) =>
      `{ ${s.private ? `private: ${JSON.stringify(s.private)}, ` : ""}init: ${literal(s.init)}, traits: [\n${scriptTraits(
        s,
      )
        .map((x) => `${x},\n`)
        .join("")}] }`,
  );
  const index = join(dir, "scripts.ts");
  writeFileSync(
    index,
    "// builtin's scripts in the order they load, each with the definitions it\n" +
      "// makes (see ../declare.ts).\n\n" +
      `import type { ScriptDecl } from "../declare.js";\n${imports.sort().join("\n")}\n\n` +
      `export const scripts: ScriptDecl[] = [\n${bodies.map((b) => `${b},\n`).join("")}];\n`,
  );
  written.push(index);

  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [abc, out] = process.argv.slice(2);
  if (!abc) {
    console.error("usage: node tools/abc-surface/declarations.ts builtin.abc [out dir]");
    process.exit(2);
  }

  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = out ?? join(root, "packages/runtime/src/avm2/builtin/declarations");
  const files = writeDeclarations(toDeclarations(readSurface(readFileSync(abc))), dir);
  execFileSync(join(root, "node_modules/.bin/biome"), ["check", "--write", dir], {
    stdio: "ignore",
  });
  console.log(`${files.length} files in ${relative(process.cwd(), dir)}`);
}
