// A domain: the ABCs loaded together, the names their scripts define, and
// their classes, linked to their base classes and interfaces. Strings and
// namespaces are interned across ABCs, so a name is a pair of ids however
// many ABCs spell it.
//
// Classes link as in avmplus' AbcParser::parseInstanceInfos: while an ABC
// loads, a type name resolves to a class some earlier ABC's script defines,
// or else to an earlier class of the same ABC. Once the ABC has linked, the
// classes its scripts define become visible to later ABCs.
//
// Namespaces follow avmplus' AbcParser: two are the same if their kind and
// URI are; a private namespace is only ever equal to itself. A URI may end
// in an API version mark (U+E294 + version), which builtin ABCs use to say
// which player version introduced a name. The mark is stripped from the URI
// and kept as the namespace's version. Versions come in two interleaved
// series, Flash Player's and AIR's; a binding gets the earliest version of
// its namespaces in the domain's series, where AIR-only versions are
// VM-internal. It is visible to a lookup whose namespace has an equal or
// later version. User ABCs' public namespaces get the domain's version, so
// they cannot see VM-internal names.
import { Abc } from "../abc/abc";
import {
  CONSTANT_ExplicitNamespace,
  CONSTANT_Multiname,
  CONSTANT_PackageInternalNs,
  CONSTANT_PrivateNs,
  CONSTANT_ProtectedNamespace,
  CONSTANT_Qname,
  CONSTANT_StaticProtectedNs,
  CONSTANT_TypeName,
  INSTANCE_Final,
  INSTANCE_Interface,
  kAmbiguousBindingError,
  kCannotExtendError,
  kCannotExtendFinalClass,
  kCannotImplementError,
  kClassNotFoundError,
  kIllegalVoidError,
  TRAIT_Class,
} from "../abc/constants";
import { readAbc } from "../abc/parse";

export const NS_Public: u8 = 0;
export const NS_PackageInternal: u8 = 1;
export const NS_Protected: u8 = 2;
export const NS_Explicit: u8 = 3;
export const NS_StaticProtected: u8 = 4;
export const NS_Private: u8 = 5;

/** avmplus' ApiVersion values that swf2es needs; see core/api-versions.h. */
export const API_AllVersions: u8 = 0;
export const API_FP_10_0: u8 = 2;
/** kApiVersionLatest for Flash Player (SWF_31), avmshell's default. */
export const API_LatestFP: u8 = 50;
export const API_Internal: u8 = 52;
const API_Count: u32 = 53;
const API_MinMark: u32 = 0xe294;

/** The URI of a namespace written with string index 0. */
export const URI_None: u32 = 0xffffffff;

/** Maps a 32-bit hash to ids by linear probing; callers compare the keys. */
@final
class IdTable {
  /** id + 1 per slot; 0 is empty. */
  ids: StaticArray<u32> = new StaticArray<u32>(64);
  hashes: StaticArray<u32> = new StaticArray<u32>(64);
  count: u32 = 0;

  @inline
  start(hash: u32): u32 {
    return hash & (<u32>this.ids.length - 1);
  }

  @inline
  next(slot: u32): u32 {
    return (slot + 1) & (<u32>this.ids.length - 1);
  }

  /** The id in `slot`, or -1 at the end of the probe. */
  @inline
  at(slot: u32): i32 {
    return <i32>unchecked(this.ids[slot]) - 1;
  }

  @inline
  hashAt(slot: u32): u32 {
    return unchecked(this.hashes[slot]);
  }

  insert(hash: u32, id: u32): void {
    if ((this.count + 1) * 4 > <u32>this.ids.length * 3) {
      this.grow();
    }

    let slot = this.start(hash);
    while (unchecked(this.ids[slot])) {
      slot = this.next(slot);
    }

    unchecked((this.ids[slot] = id + 1));
    unchecked((this.hashes[slot] = hash));
    this.count++;
  }

  grow(): void {
    const ids = this.ids;
    const hashes = this.hashes;
    this.ids = new StaticArray<u32>(ids.length * 2);
    this.hashes = new StaticArray<u32>(ids.length * 2);
    this.count = 0;

    // Re-inserting in slot order keeps equal hashes in insertion order.
    const size = <u32>ids.length;
    let first: u32 = 0;
    while (first < size && unchecked(ids[first])) {
      first++;
    }

    for (let i: u32 = 1; i <= size; i++) {
      const slot = (first + i) & (size - 1);
      if (unchecked(ids[slot])) {
        this.insert(unchecked(hashes[slot]), unchecked(ids[slot]) - 1);
      }
    }
  }
}

function hashBytes(ptr: usize, length: u32): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i: u32 = 0; i < length; i++) {
    h = (h ^ load<u8>(ptr + i)) * 0x01000193;
  }

  return h;
}

function hashPair(a: u32, b: u32): u32 {
  let h = a * 0x9e3779b1;
  h ^= b + 0x7f4a7c15 + (h << 6) + (h >> 2);
  return h ^ (h >> 16);
}

@final
export class Domain {
  /** The version of user ABCs' public namespaces. */
  apiVersion: u8 = API_LatestFP;
  /** Whether the domain runs AIR's series of API versions rather than Flash Player's. */
  air: bool = false;

  abcs: Abc[] = [];
  /**
   * The bytes of every ABC ever added, followed by PADDING, including those
   * rejected while linking: interned strings may point into any of them.
   */
  buffers: StaticArray<u8>[] = [];
  /** Per ABC, the interned id of each pool string, and of each namespace and its version. */
  abcString: StaticArray<u32>[] = [];
  abcNs: StaticArray<u32>[] = [];
  abcNsVersion: StaticArray<u8>[] = [];

  stringPtr: usize[] = [];
  stringLength: u32[] = [];
  strings: IdTable = new IdTable();
  /** URIs a builtin ABC marks with a version: their unmarked public names are VM-internal. */
  versioned: u8[] = [];

  nsType: u8[] = [];
  nsUri: u32[] = [];
  namespaces: IdTable = new IdTable();

  // Script traits by name, in load order; the first visible one wins.
  bindingNs: u32[] = [];
  bindingName: u32[] = [];
  bindingVersion: u8[] = [];
  bindingAbc: u32[] = [];
  bindingScript: u32[] = [];
  /** Index of the trait in its ABC's trait tables. */
  bindingTrait: u32[] = [];
  bindings: IdTable = new IdTable();

  // Classes by domain-wide id; ABC a's instance i is classStart[a] + i.
  classStart: u32[] = [];
  classAbc: u32[] = [];
  classInstance: u32[] = [];
  /** The base class's id, or -1. */
  classBase: i32[] = [];
  classFlags: u8[] = [];

  /**
   * Class names. Those a script defines are visible to every ABC (owner -1);
   * while an ABC links, its own classes are visible to it by instance name
   * (owner: its load number, which a rejected ABC never gives to another).
   */
  typeNs: u32[] = [];
  typeName: u32[] = [];
  typeVersion: u8[] = [];
  typeClass: u32[] = [];
  typeOwner: i32[] = [];
  types: IdTable = new IdTable();
  loads: i32 = 0;
  /** Strings interned from text rather than an ABC, kept for their bytes. */
  texts: ArrayBuffer[] = [];

  // The builtin classes linking treats specially, found when the first
  // builtin ABC links; -1 if it has none.
  hasBuiltins: bool = false;
  classClass: i32 = -1;
  functionClass: i32 = -1;
  /** avmplus registers void as a class, which nothing may extend. */
  voidClass: i32 = -1;

  /**
   * Parse and add the ABC in `buffer`, whose first `length` bytes are the ABC
   * and the rest PADDING. Returns the ABC; check its `error`.
   */
  add(buffer: StaticArray<u8>, length: u32, builtin: bool): Abc {
    const base = changetype<usize>(buffer);
    const abc = readAbc(base, length, builtin);
    if (abc.error) {
      return abc;
    }

    const index = <u32>this.abcs.length;
    this.abcs.push(abc);
    this.buffers.push(buffer);
    this.loads++;

    const pool = abc.pool;
    const strings = new StaticArray<u32>(pool.stringCount);
    for (let i: u32 = 1; i < pool.stringCount; i++) {
      const ptr = base + unchecked(pool.stringStart[i]);
      unchecked((strings[i] = this.internString(ptr, unchecked(pool.stringLength[i]))));
    }

    this.abcString.push(strings);
    this.addNamespaces(abc, base, strings);
    if (!this.link(index)) {
      this.abcs.pop();
      this.abcString.pop();
      this.abcNs.pop();
      this.abcNsVersion.pop();
      this.classStart.pop();
      return abc;
    }

    this.addClassNames(index);
    this.addBindings(index);
    return abc;
  }

  /** Link ABC `index`'s classes to their bases and interfaces; false after recording the error. */
  link(index: u32): bool {
    const abc = unchecked(this.abcs[index]);
    const first = <u32>this.classAbc.length;
    this.classStart.push(first);
    for (let i: u32 = 0; i < abc.classCount; i++) {
      this.classAbc.push(index);
      this.classInstance.push(i);
      this.classBase.push(-1);
      this.classFlags.push(unchecked(abc.instanceFlags[i]));
    }

    for (let i: u32 = 0; i < abc.classCount; i++) {
      const id = first + i;
      const flags = unchecked(abc.instanceFlags[i]);
      const baseName = unchecked(abc.instanceSuper[i]);
      if (baseName) {
        const base = this.resolveType(index, baseName);
        if (base < 0) {
          return abc.fail(-base);
        }

        if (
          unchecked(this.classFlags[base]) & INSTANCE_Final ||
          base === this.classClass ||
          (base === this.functionClass && !abc.builtin)
        ) {
          return abc.fail(kCannotExtendFinalClass);
        }

        if (unchecked(this.classFlags[base]) & INSTANCE_Interface) {
          return abc.fail(kCannotExtendError);
        }

        unchecked((this.classBase[id] = base));
      }

      const last = unchecked(abc.instanceInterfaceStart[i + 1]);
      for (let j = unchecked(abc.instanceInterfaceStart[i]); j < last; j++) {
        const t = this.resolveType(index, unchecked(abc.interfaces[j]));
        if (t < 0) {
          return abc.fail(-t);
        }

        if (!(unchecked(this.classFlags[t]) & INSTANCE_Interface)) {
          return abc.fail(kCannotImplementError);
        }
      }

      if (flags & INSTANCE_Interface && baseName) {
        return abc.fail(kCannotExtendError);
      }

      this.nameInstance(index, i);
    }

    // As AvmCore's first builtin pool: its classes include the special ones.
    if (abc.builtin && !this.hasBuiltins) {
      this.hasBuiltins = true;
      this.classClass = this.findPublicClass("Class");
      this.functionClass = this.findPublicClass("Function");
      this.voidClass = <i32>this.classAbc.length;
      this.classAbc.push(index);
      this.classInstance.push(0xffffffff);
      this.classBase.push(-1);
      this.classFlags.push(INSTANCE_Final);
      const empty = this.internNamespace(NS_Public, this.internText(""));
      this.nameType(empty, this.internText("void"), API_AllVersions, this.voidClass, -1);
    }

    return true;
  }

  /**
   * As PoolObject::resolveTypeName for a base class or interface: the class
   * id, or minus the error: 1014 if nothing matches, 1008 if two classes do,
   * 1022 for void.
   */
  resolveType(index: u32, mn: u32): i32 {
    const abc = unchecked(this.abcs[index]);
    const pool = abc.pool;
    const kind = unchecked(pool.mnKind[mn]);
    if (kind === CONSTANT_TypeName) {
      const base = this.resolveType(index, unchecked(pool.mnA[mn]));
      const param = unchecked(pool.mnB[mn]);
      if (base >= 0 && param) {
        const t = this.resolveType(index, param);
        if (t < 0) {
          return t;
        }
      }

      return base;
    }

    const strings = unchecked(this.abcString[index]);
    const ids = unchecked(this.abcNs[index]);
    const versions = unchecked(this.abcNsVersion[index]);
    const nameIndex = unchecked(pool.mnB[mn]);
    let found: i32 = -1;
    if (kind === CONSTANT_Qname && unchecked(pool.mnA[mn]) !== 0 && nameIndex !== 0) {
      const ns = unchecked(pool.mnA[mn]);
      found = this.findType(ids[ns], strings[nameIndex], versions[ns]);
    } else if (kind === CONSTANT_Multiname && nameIndex !== 0) {
      const set = unchecked(pool.mnA[mn]);
      const last = unchecked(pool.nsSetStart[set + 1]);
      for (let m = unchecked(pool.nsSetStart[set]); m < last; m++) {
        const ns = unchecked(pool.nsSetMembers[m]);
        const t = this.findType(ids[ns], strings[nameIndex], versions[ns]);
        if (t >= 0 && found >= 0 && t !== found) {
          return -kAmbiguousBindingError;
        }

        if (t >= 0) {
          found = t;
        }
      }
    }

    if (found < 0) {
      return -kClassNotFoundError;
    }

    return found === this.voidClass ? -kIllegalVoidError : found;
  }

  /**
   * As DomainMgr::findTraitsInPoolByNameAndNS for the ABC being linked: a
   * class a script defines, else one of the ABC's own; -1 if none.
   */
  findType(ns: u32, name: u32, version: u8): i32 {
    const found = this.findTypeOf(ns, name, version, -1);
    return found >= 0 ? found : this.findTypeOf(ns, name, version, this.loads);
  }

  findTypeOf(ns: u32, name: u32, version: u8, owner: i32): i32 {
    const hash = hashPair(ns, name);
    const table = this.types;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (
        unchecked(this.typeNs[id]) === ns &&
        unchecked(this.typeName[id]) === name &&
        unchecked(this.typeVersion[id]) <= version &&
        unchecked(this.typeOwner[id]) === owner
      ) {
        return <i32>unchecked(this.typeClass[id]);
      }

      slot = table.next(slot);
    }
  }

  nameType(ns: u32, name: u32, version: u8, id: i32, owner: i32): void {
    const type = <u32>this.typeNs.length;
    this.typeNs.push(ns);
    this.typeName.push(name);
    this.typeVersion.push(version);
    this.typeClass.push(<u32>id);
    this.typeOwner.push(owner);
    this.types.insert(hashPair(ns, name), type);
  }

  /** As DomainMgr::addNamedInstanceTraits: instance i's name, unless something is already found by it. */
  nameInstance(index: u32, i: u32): void {
    const abc = unchecked(this.abcs[index]);
    const pool = abc.pool;
    let mn = unchecked(abc.instanceName[i]);
    if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
      mn = unchecked(pool.mnA[mn]);
    }

    let ns = unchecked(pool.mnA[mn]);
    if (unchecked(pool.mnKind[mn]) === CONSTANT_Multiname) {
      ns = unchecked(pool.nsSetMembers[pool.nsSetStart[ns]]);
    }

    const nsId = unchecked(this.abcNs[index][ns]);
    const version = unchecked(this.abcNsVersion[index][ns]);
    const name = unchecked(this.abcString[index][pool.mnB[mn]]);
    if (this.findType(nsId, name, version) < 0) {
      this.nameType(nsId, name, version, <i32>(this.classStart[index] + i), this.loads);
    }
  }

  /**
   * As AbcParser::addNamedTraits: every class a script of ABC `index`
   * defines, visible to all later ABCs unless the domain has the name already.
   */
  addClassNames(index: u32): void {
    const abc = unchecked(this.abcs[index]);
    const pool = abc.pool;
    const ids = unchecked(this.abcNs[index]);
    const versions = unchecked(this.abcNsVersion[index]);
    const strings = unchecked(this.abcString[index]);
    const first = unchecked(abc.scriptTraitStart[0]);
    const end = unchecked(abc.scriptTraitStart[abc.scriptCount]);
    for (let t = first; t < end; t++) {
      if ((unchecked(abc.traitTag[t]) & 0x0f) !== TRAIT_Class) {
        continue;
      }

      let mn = unchecked(abc.traitName[t]);
      if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
        mn = unchecked(pool.mnA[mn]);
      }

      let ns = unchecked(pool.mnA[mn]);
      let version = this.activeVersion(unchecked(versions[ns]));
      if (unchecked(pool.mnKind[mn]) === CONSTANT_Multiname) {
        const set = ns;
        const last = unchecked(pool.nsSetStart[set + 1]);
        ns = unchecked(pool.nsSetMembers[pool.nsSetStart[set]]);
        version = API_Internal;
        for (let m = unchecked(pool.nsSetStart[set]); m < last; m++) {
          const v = this.activeVersion(unchecked(versions[pool.nsSetMembers[m]]));
          if (v < version) {
            version = v;
          }
        }
      }

      const nsId = unchecked(ids[ns]);
      const name = unchecked(strings[pool.mnB[mn]]);
      if (
        unchecked(this.nsType[nsId]) !== NS_Private &&
        this.findTypeOf(nsId, name, version, -1) < 0
      ) {
        const id = unchecked(this.classStart[index]) + unchecked(abc.traitIndex[t]);
        this.nameType(nsId, name, version, <i32>id, -1);
      }
    }
  }

  /** The class the ABC being linked names public::`name`, or -1. */
  findPublicClass(name: string): i32 {
    const empty = this.findText("");
    const text = this.findText(name);
    const ns = empty < 0 ? -1 : this.findNamespace(NS_Public, <u32>empty);
    return ns < 0 || text < 0 ? -1 : this.findTypeOf(ns, <u32>text, API_Internal, this.loads);
  }

  findText(text: string): i32 {
    const bytes = String.UTF8.encode(text);
    return this.findString(changetype<usize>(bytes), bytes.byteLength);
  }

  /** Intern a string that is not in an ABC. */
  internText(text: string): u32 {
    const bytes = String.UTF8.encode(text);
    const found = this.findString(changetype<usize>(bytes), bytes.byteLength);
    if (found >= 0) {
      return <u32>found;
    }

    this.texts.push(bytes);
    return this.internString(changetype<usize>(bytes), bytes.byteLength);
  }

  internString(ptr: usize, length: u32): u32 {
    const found = this.findString(ptr, length);
    if (found >= 0) {
      return <u32>found;
    }

    const id = <u32>this.stringPtr.length;
    this.stringPtr.push(ptr);
    this.stringLength.push(length);
    this.versioned.push(0);
    this.strings.insert(hashBytes(ptr, length), id);
    return id;
  }

  /** The id of a string already interned, or -1. */
  findString(ptr: usize, length: u32): i32 {
    const hash = hashBytes(ptr, length);
    const table = this.strings;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (
        table.hashAt(slot) === hash &&
        unchecked(this.stringLength[id]) === length &&
        memory.compare(unchecked(this.stringPtr[id]), ptr, length) === 0
      ) {
        return id;
      }

      slot = table.next(slot);
    }
  }

  /** The id of a namespace, interning it; private namespaces are always new. */
  internNamespace(type: u8, uri: u32): u32 {
    if (type !== NS_Private) {
      const found = this.findNamespace(type, uri);
      if (found >= 0) {
        return <u32>found;
      }
    }

    const id = <u32>this.nsType.length;
    this.nsType.push(type);
    this.nsUri.push(uri);
    if (type !== NS_Private) {
      this.namespaces.insert(hashPair(type, uri), id);
    }

    return id;
  }

  findNamespace(type: u8, uri: u32): i32 {
    const hash = hashPair(type, uri);
    const table = this.namespaces;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (unchecked(this.nsType[id]) === type && unchecked(this.nsUri[id]) === uri) {
        return id;
      }

      slot = table.next(slot);
    }
  }

  /**
   * The binding of `name` in namespace `ns` visible at `version`, or -1:
   * the first one loaded, as a domain keeps the first definition of a name.
   */
  find(ns: u32, name: u32, version: u8): i32 {
    const hash = hashPair(ns, name);
    const table = this.bindings;
    let slot = table.start(hash);
    while (true) {
      const id = table.at(slot);
      if (id < 0) {
        return -1;
      }

      if (
        unchecked(this.bindingNs[id]) === ns &&
        unchecked(this.bindingName[id]) === name &&
        unchecked(this.bindingVersion[id]) <= version
      ) {
        return id;
      }

      slot = table.next(slot);
    }
  }

  /** As AbcParser::parseCpool: each namespace's interned id and API version. */
  addNamespaces(abc: Abc, base: usize, strings: StaticArray<u32>): void {
    const pool = abc.pool;
    const count = pool.nsCount;
    const ids = new StaticArray<u32>(count);
    const versions = new StaticArray<u8>(count);
    const marks = new StaticArray<i32>(count);

    // A builtin ABC's marked URIs are versioned before any of its namespaces
    // get a version, as the player registers them before parsing.
    for (let i: u32 = 1; i < count; i++) {
      const index = unchecked(pool.nsName[i]);
      const mark = index
        ? versionMark(base, pool.stringStart[index], pool.stringLength[index])
        : -1;
      unchecked((marks[i] = mark));
      if (abc.builtin && mark >= 0 && namespaceType(pool.nsKind[i]) === NS_Public) {
        const uri = this.internString(base + pool.stringStart[index], pool.stringLength[index] - 3);
        unchecked((this.versioned[uri] = 1));
      }
    }

    for (let i: u32 = 1; i < count; i++) {
      const type = namespaceType(unchecked(pool.nsKind[i]));
      const index = unchecked(pool.nsName[i]);
      const mark = unchecked(marks[i]);
      let uri = index ? unchecked(strings[index]) : URI_None;
      let version = API_AllVersions;
      if (mark >= 0) {
        uri = this.internString(base + pool.stringStart[index], pool.stringLength[index] - 3);
        version = <u8>mark;
      }

      if (type === NS_Private) {
        version = API_AllVersions;
      } else if (index && abc.builtin) {
        if (mark < 0 && type === NS_Public && unchecked(this.versioned[uri])) {
          version = API_Internal;
        }
      } else if (index && type === NS_Public) {
        version = this.apiVersion;
      }

      unchecked((ids[i] = this.internNamespace(type, uri)));
      unchecked((versions[i] = version));
    }

    this.abcNs.push(ids);
    this.abcNsVersion.push(versions);
  }

  /**
   * Every script trait of ABC `index`, as AbcParser::addNamedScript binds it:
   * under its name's first namespace, with the earliest of their versions.
   */
  addBindings(index: u32): void {
    const abc = unchecked(this.abcs[index]);
    const pool = abc.pool;
    const strings = unchecked(this.abcString[index]);
    const ids = unchecked(this.abcNs[index]);
    const versions = unchecked(this.abcNsVersion[index]);
    for (let script: u32 = 0; script < abc.scriptCount; script++) {
      const end = unchecked(abc.scriptTraitStart[script + 1]);
      for (let t = unchecked(abc.scriptTraitStart[script]); t < end; t++) {
        let mn = unchecked(abc.traitName[t]);
        if (unchecked(pool.mnKind[mn]) === CONSTANT_TypeName) {
          mn = unchecked(pool.mnA[mn]);
        }

        const name = unchecked(strings[pool.mnB[mn]]);
        let first = unchecked(pool.mnA[mn]);
        let version = this.activeVersion(unchecked(versions[first]));
        if (unchecked(pool.mnKind[mn]) === CONSTANT_Multiname) {
          const set = unchecked(pool.mnA[mn]);
          const last = unchecked(pool.nsSetStart[set + 1]);
          first = unchecked(pool.nsSetMembers[pool.nsSetStart[set]]);
          version = API_Internal;
          for (let m = unchecked(pool.nsSetStart[set]); m < last; m++) {
            const v = this.activeVersion(unchecked(versions[pool.nsSetMembers[m]]));
            if (v < version) {
              version = v;
            }
          }
        }

        this.bind(unchecked(ids[first]), name, version, index, script, t);
      }
    }
  }

  /**
   * As kApiVersionSeriesTransfer: a version of the other series becomes the
   * first later one of the domain's, which for Flash Player means AIR-only
   * versions become VM-internal.
   */
  activeVersion(version: u8): u8 {
    if (version === API_AllVersions || version >= API_Internal || isAir(version) === this.air) {
      return version;
    }

    if (!this.air) {
      return API_Internal;
    }

    let v = version + 1;
    while (!isAir(v)) {
      v++;
    }

    return v;
  }

  bind(ns: u32, name: u32, version: u8, abc: u32, script: u32, trait: u32): void {
    const id = <u32>this.bindingNs.length;
    this.bindingNs.push(ns);
    this.bindingName.push(name);
    this.bindingVersion.push(version);
    this.bindingAbc.push(abc);
    this.bindingScript.push(script);
    this.bindingTrait.push(trait);
    this.bindings.insert(hashPair(ns, name), id);
  }
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

function namespaceType(kind: u8): u8 {
  switch (kind) {
    case CONSTANT_PackageInternalNs:
      return NS_PackageInternal;
    case CONSTANT_ProtectedNamespace:
      return NS_Protected;
    case CONSTANT_ExplicitNamespace:
      return NS_Explicit;
    case CONSTANT_StaticProtectedNs:
      return NS_StaticProtected;
    case CONSTANT_PrivateNs:
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
