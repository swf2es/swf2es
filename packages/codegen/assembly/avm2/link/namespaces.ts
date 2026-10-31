// An ABC's namespaces as avmplus' AbcParser::parseCpool reads them: each
// interned by its kind and URI, and given its API version, from the mark a
// builtin ABC's URI ends in, moved into the domain's series.

import { Abc } from "../abc/abc";
import * as C from "../abc/constants";
import {
  API_AllVersions,
  API_FP_10_0,
  API_Internal,
  Domain,
  NS_Explicit,
  NS_PackageInternal,
  NS_Private,
  NS_Protected,
  NS_Public,
  NS_StaticProtected,
  URI_None,
} from "./domain";

/**
 * VM_INTERNAL is the last mark of the table an ABC was built with: 42 in
 * the AIR 15 SDK's, which the oracle's playerglobal has, 52 in
 * core/api-versions.h, which the submodule's builtin has. A builtin ABC's
 * highest mark, from 42 up, is its internal one.
 */
const API_FirstInternalMark: i32 = 42;
const API_Count: u32 = 53;
const API_MinMark: u32 = 0xe294;

/** As AbcParser::parseCpool: each namespace's interned id and API version. */
export function addNamespaces(dom: Domain, abc: Abc, base: usize, strings: StaticArray<u32>): void {
  const pool = abc.pool;
  const count = pool.nsCount;
  const ids = new StaticArray<u32>(count);
  const versions = new StaticArray<u8>(count);
  const marks = new StaticArray<i32>(count);

  // A builtin ABC's marked URIs are versioned before any of its namespaces
  // get a version, as the player registers them before parsing.
  let highestMark: i32 = -1;
  for (let i: u32 = 1; i < count; i++) {
    const index = pool.nsName[i];
    const mark = index ? versionMark(base, pool.stringStart[index], pool.stringLength[index]) : -1;
    marks[i] = mark;
    if (mark > highestMark) {
      highestMark = mark;
    }

    if (abc.builtin && mark >= 0 && namespaceType(pool.nsKind[i]) === NS_Public) {
      const uri = dom.internString(base + pool.stringStart[index], pool.stringLength[index] - 3);
      dom.versioned[uri] = 1;
    }
  }

  for (let i: u32 = 1; i < count; i++) {
    const type = namespaceType(pool.nsKind[i]);
    const index = pool.nsName[i];
    const mark = marks[i];
    let uri = index ? strings[index] : URI_None;
    let version = API_AllVersions;
    if (mark >= 0) {
      uri = dom.internString(base + pool.stringStart[index], pool.stringLength[index] - 3);
      version = <u8>mark;
    }

    if (type === NS_Private) {
      version = API_AllVersions;
    } else if (index && abc.builtin) {
      if (
        (mark < 0 && type === NS_Public && dom.versioned[uri]) ||
        (mark >= API_FirstInternalMark && mark === highestMark)
      ) {
        version = API_Internal;
      }
    } else if (index && type === NS_Public) {
      version = dom.apiVersion;
    }

    ids[i] = dom.internNamespace(type, uri);
    // As AvmCore::newNamespace: in the domain's series, so that a lookup
    // compares versions of the series its bindings have.
    versions[i] = activeVersion(dom, version);
  }

  dom.abcNs.push(ids);
  dom.abcNsVersion.push(versions);
}

/**
 * As kApiVersionSeriesTransfer: a version of the other series becomes the
 * first later one of the domain's, which for Flash Player means AIR-only
 * versions become VM-internal.
 */
function activeVersion(dom: Domain, version: u8): u8 {
  const air = dom.apiVersion !== API_AllVersions && isAir(dom.apiVersion);
  if (version === API_AllVersions || version >= API_Internal || isAir(version) === air) {
    return version;
  }

  if (!air) {
    return API_Internal;
  }

  let v = version + 1;
  while (!isAir(v)) {
    v++;
  }

  return v;
}

/**
 * Whether an API version belongs to AIR's series: versions alternate between
 * the series, FP_10_0, FP_10_0_32 and FP_10_1 aside, from FP_10_2 on.
 */
function isAir(version: u8): bool {
  if (version >= 10) {
    return (version & 1) === 1;
  }

  return version !== API_FP_10_0 && version !== 5 && version !== 7;
}

export function namespaceType(kind: u8): u8 {
  switch (kind) {
    case C.CONSTANT_PackageInternalNs:
      return NS_PackageInternal;
    case C.CONSTANT_ProtectedNamespace:
      return NS_Protected;
    case C.CONSTANT_ExplicitNamespace:
      return NS_Explicit;
    case C.CONSTANT_StaticProtectedNs:
      return NS_StaticProtected;
    case C.CONSTANT_PrivateNs:
      return NS_Private;
    default:
      return NS_Public;
  }
}

/**
 * The API version a string's last character marks, or -1. The marks are
 * U+E294 to U+E2C8, three bytes in UTF-8.
 */
function versionMark(base: usize, start: u32, length: u32): i32 {
  if (length < 3) {
    return -1;
  }

  const p = base + start + length - 3;
  const b0 = <u32>load<u8>(p);
  const b1 = <u32>load<u8>(p + 1);
  const b2 = <u32>load<u8>(p + 2);
  if ((b0 & 0xf0) !== 0xe0 || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
    return -1;
  }

  const c = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
  return c >= API_MinMark && c < API_MinMark + API_Count ? <i32>(c - API_MinMark) : -1;
}
