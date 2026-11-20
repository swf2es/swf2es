// Each method's name as Flash's debugger player names it in a stack trace
// ("Test/get x", "Test$cinit", "global$init", "Function/<anonymous>"),
// spelled into the JavaScript identifier of its function, so that the
// runtime reads it back from the engine's stack (stackNames in the
// runtime's errors.ts) and nothing more is emitted or run for it.

import * as C from "../abc/constants";
import { Domain, NS_Public, URI_None } from "../link/domain";
import { TRAITS_Class, TRAITS_Instance, TRAITS_Script } from "../link/traits";

/**
 * Method m's (a domain-wide index) name in a stack trace, as the debugger
 * player prints it: its declaring class's name, then "/" and its own, or
 * "/get " and "/set " for an accessor; a constructor its class's name, a
 * class's initializer "Name$cinit", a script's "global$init"; a class's
 * static method under "Name$", a script's function under "global"; a
 * closure "Function/" and its debug name, "<anonymous>" if empty, or
 * "MethodInfo-" and its index if it has none, or one outside the pool. A name in a public namespace
 * other than the unnamed one, a package's or the AS3 namespace, carries
 * its URI; one in any other, private or internal, does not.
 */
export function stackName(domain: Domain, index: u32, m: u32): string {
  const traits = domain.traits;
  const abc = domain.abcs[index];
  const local = m - domain.methodStart[index];
  const t = traits.methodTraits[m];
  if (t >= 0) {
    const kind = traits.kind[t];
    const owner = traits.owner[t];
    let declaring = "";
    if (kind === TRAITS_Instance || kind === TRAITS_Class) {
      declaring = className(domain, traits.abc[t], owner);
      if (kind === TRAITS_Class) {
        declaring += "$";
        if (abc.classInit[owner] === local) {
          return `${declaring}cinit`;
        }
      } else if (abc.instanceInit[owner] === local) {
        return declaring;
      }
    } else if (kind === TRAITS_Script) {
      if (abc.scriptInit[owner] === local) {
        return "global$init";
      }

      declaring = "global";
    }

    if (declaring.length) {
      for (let i = traits.first[t]; i < traits.end[t]; i++) {
        const tk = abc.traitTag[i] & 0x0f;
        if (
          (tk === C.TRAIT_Method || tk === C.TRAIT_Getter || tk === C.TRAIT_Setter) &&
          abc.traitIndex[i] === local
        ) {
          traits.readName(domain, index, i);
          const separator = tk === C.TRAIT_Getter ? "/get " : tk === C.TRAIT_Setter ? "/set " : "/";
          return declaring + separator + shown(domain, traits.nameNs, traits.nameId);
        }
      }
    }
  }

  // The debug name's index is read unchecked, as avmplus reads it: one
  // past the pool is no name, as PoolObject::hasString has it.
  const name = abc.methodName[local];
  if (name === 0 || name >= abc.pool.stringCount) {
    return `MethodInfo-${local.toString()}`;
  }

  const id = domain.abcString[index][name];
  const text = String.UTF8.decodeUnsafe(domain.stringPtr[id], domain.stringLength[id]);
  return `Function/${text.length ? text : "<anonymous>"}`;
}

/** Class `owner` of ABC `index`'s name, as shown: its namespace's URI only where it is public. */
function className(domain: Domain, index: u32, owner: u32): string {
  const abc = domain.abcs[index];
  const pool = abc.pool;
  let mn = abc.instanceName[owner];
  if (pool.mnKind[mn] === C.CONSTANT_TypeName) {
    mn = pool.mnA[mn];
  }

  let ns = pool.mnA[mn];
  if (pool.mnKind[mn] === C.CONSTANT_Multiname) {
    ns = pool.nsSetMembers[pool.nsSetStart[ns]];
  }

  return shown(domain, domain.abcNs[index][ns], domain.abcString[index][pool.mnB[mn]]);
}

/** Interned name `name` in interned namespace `ns`, as shown. */
function shown(domain: Domain, ns: u32, name: u32): string {
  const text = String.UTF8.decodeUnsafe(domain.stringPtr[name], domain.stringLength[name]);
  const uri = domain.nsUri[ns];
  if (domain.nsType[ns] !== NS_Public || uri === URI_None || domain.stringLength[uri] === 0) {
    return text;
  }

  return `${String.UTF8.decodeUnsafe(domain.stringPtr[uri], domain.stringLength[uri])}::${text}`;
}

/**
 * `name` as a JavaScript identifier: "$_", which marks the runtime's
 * stacks' frames of compiled code, then the name, every character but
 * [A-Za-z0-9_] escaped after a `$`: "$$" for "$", one letter for
 * the characters names hold most ("/" s, ":" c, "." d, " " w, "<" l, ">"
 * g, "-" m), and "x" and four hex digits for any other code unit. "u" is
 * no escape: a bound entry is its method's name and "$u" (boundEntry).
 */
export function identifierOf(name: string): string {
  // Into one buffer, made once: the minimal runtime collects only between calls.
  const units = new StaticArray<u16>(name.length * 6 + 2);
  let n = 0;
  units[n++] = 0x24; // $
  units[n++] = 0x5f; // _
  for (let i = 0; i < name.length; i++) {
    const c = <u16>name.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      units[n++] = c;
      continue;
    }

    units[n++] = 0x24;
    switch (c) {
      case 0x24: // $
        units[n++] = 0x24;
        break;
      case 0x2f: // /
        units[n++] = 0x73; // s
        break;
      case 0x3a: // :
        units[n++] = 0x63; // c
        break;
      case 0x2e: // .
        units[n++] = 0x64; // d
        break;
      case 0x20: // space
        units[n++] = 0x77; // w
        break;
      case 0x3c: // <
        units[n++] = 0x6c; // l
        break;
      case 0x3e: // >
        units[n++] = 0x67; // g
        break;
      case 0x2d: // -
        units[n++] = 0x6d; // m
        break;
      default:
        units[n++] = 0x78; // x
        for (let shift = 12; shift >= 0; shift -= 4) {
          const digit = (<i32>c >> shift) & 0xf;
          units[n++] = <u16>(digit < 10 ? 48 + digit : 87 + digit);
        }
    }
  }

  return String.UTF16.decodeUnsafe(changetype<usize>(units), n << 1);
}
