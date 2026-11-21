// The compiler's log as a module cache key names it, by digests chained a
// block of entries at a time, so that a key costs what the log gained
// since the last, not the whole of it (docs/architecture/modules.md,
// "Caching modules").
//
// A key names the log as its ABC's application domain sees it (codegen's
// domainContext). Its entries made before the last ABC the domain sees
// was added are settled: none changes while the domain is live and the
// compiler not rebuilt, and which they are depends on what the domain
// sees alone. A key names those by the chained digests of their blocks of
// KEY_BLOCK entries, sha256(previous digest + block), and the rest by
// their text. Each domain keeps where its chain is, the digest so far
// and the settled entries after the last block, so the next key reads
// only the entries made since; a new domain's chain starts as its
// parent's is where the two logs part (domainKeyFork), so a parent's
// chain may run past its own settled entries, and its key then splits at
// the last block's end before them. The blocks are the same however they
// were read, so the key is the same as one taken from nothing.
import { sha256Joined } from "./sha256.js";

/** How many entries of the log each chained digest takes. */
const KEY_BLOCK = 64;

/** How many digests of its blocks a domain keeps, for a new child's start. */
const KEPT = 8;

/** What the chain asks of codegen.wasm, as the wrapper or the test build gives it. */
export interface KeyLog {
  /** domainKeyHeaderBytes' text: "" where there is no ABC `index`. */
  header(index: number): string;
  /** domainParent: -1 for the root. */
  parent(appDomain: number): number;
  /** domainKeyFork. */
  fork(appDomain: number): number;
  /** domainKeyLogBytes, read before the next call into codegen; null where it gave none. */
  log(
    appDomain: number,
    after: number,
    from: number,
    to: number,
    block: number,
    filled: number,
  ): Uint8Array | null;
}

/** What a module key names of an ABC's domain (see moduleKey). */
export interface KeyContext {
  /** The ABCs its application domain sees, by their positions among those added, in load order. */
  abcs: number[];
  /** Its own place in `abcs`. */
  own: number;
  /** The chained digest of the log's blocks; "" for none. */
  blocks: string;
  /** The log's entries after them, each after a line break. */
  rest: string;
}

/**
 * Where a domain's chain goes on from: log entry `entry`, the digest of the
 * blocks before, and the settled entries after them, `filled` of them.
 */
interface Mark {
  entry: number;
  digest: string;
  partial: Uint8Array;
  filled: number;
}

/** A domain's chain: where it goes on from, and the last ends of its blocks, for a new child's start. */
interface Chain {
  marks: Mark[];
  at: Mark;
}

const EMPTY = new Uint8Array(0);
const NONE: Mark = { entry: 0, digest: "", partial: EMPTY, filled: 0 };

/**
 * Each application domain's chain of digests, by the domain and how many
 * ABCs' entries the log it keys leaves out. Cleared whenever its numbers
 * may be another domain's or its entries others: as the compiler's domain
 * is reset, and as it is rebuilt.
 */
export class KeyChains {
  private readonly codegen: KeyLog;
  private readonly chains = new Map<string, Chain>();
  private generation = -1;

  constructor(codegen: KeyLog) {
    this.codegen = codegen;
  }

  clear(): void {
    this.chains.clear();
    this.generation = -1;
  }

  /** Let go of the chains of the application domains `dropped` names. */
  forget(dropped: (appDomain: number) => boolean): void {
    for (const name of this.chains.keys()) {
      if (dropped(Number(name.slice(0, name.indexOf(" "))))) {
        this.chains.delete(name);
      }
    }
  }

  /** ABC `index`'s context, the log's entries made with `after` ABCs added or fewer left out; null where there is none. */
  context(index: number, after: number): KeyContext | null {
    const header = this.codegen.header(index);
    if (header === "") {
      return null;
    }

    const lines = header.split("\n");
    const appDomain = Number(lines[2]);
    const generation = Number(lines[3]);
    const settled = Number(lines[4]);
    if (generation !== this.generation) {
      this.chains.clear();
      this.generation = generation;
    }

    const chain = this.chain(appDomain, after, settled);
    if (chain === null) {
      return null;
    }

    // Gone past the settled entries for a child's start: from the last
    // block's end before them, as the key splits its blocks there.
    let at = chain.at;
    if (at.entry > settled) {
      const back: Chain = { marks: [], at: before(chain.marks, settled) };
      if (!this.extend(appDomain, after, back, settled)) {
        return null;
      }

      at = back.at;
    }

    const rest = this.codegen.log(appDomain, after, settled, -1, 0, 0);
    if (rest === null) {
      return null;
    }

    return {
      abcs: lines[0] ? lines[0].split(",").map(Number) : [],
      own: Number(lines[1]),
      blocks: at.digest,
      rest: ascii.decode(at.partial) + ascii.decode(rest.subarray(0, rest.lastIndexOf(0x0a))),
    };
  }

  /** `appDomain`'s chain, gone on with up to entry `limit`; null, and none kept, where it is not live. */
  private chain(appDomain: number, after: number, limit: number): Chain | null {
    const name = `${appDomain} ${after}`;
    const kept = this.chains.get(name);
    const chain = kept ?? { marks: [], at: this.start(appDomain, after) };
    if (!this.extend(appDomain, after, chain, limit)) {
      return null;
    }

    if (kept === undefined) {
      this.chains.set(name, chain);
    }

    return chain;
  }

  /** Go on with `appDomain`'s `chain` up to entry `limit`: false where the domain is not live. */
  private extend(appDomain: number, after: number, chain: Chain, limit: number): boolean {
    const { entry, filled } = chain.at;
    const bytes = this.codegen.log(
      appDomain,
      after,
      entry,
      Math.max(entry, limit),
      KEY_BLOCK,
      filled,
    );
    if (bytes === null) {
      return false;
    }

    read(bytes, chain);
    return true;
  }

  /** Where a domain's chain starts: where its parent's is last before the two part, else at none. */
  private start(appDomain: number, after: number): Mark {
    const parent = this.codegen.parent(appDomain);
    if (parent < 0) {
      return NONE;
    }

    const fork = this.codegen.fork(appDomain);
    const chain = this.chain(parent, after, fork);
    if (chain === null) {
      return NONE;
    }

    return chain.at.entry <= fork ? chain.at : before(chain.marks, fork);
  }
}

/** The last of `marks` at or before entry `entry`, else none. */
function before(marks: Mark[], entry: number): Mark {
  for (let k = marks.length - 1; k >= 0; k--) {
    if (marks[k].entry <= entry) {
      return marks[k];
    }
  }

  return NONE;
}

/**
 * Go on with `chain` by domainKeyLogBytes' `bytes`: each block's digest
 * chained, a mark at its end, the oldest let go of past KEPT, and where it
 * goes on from next.
 */
function read(bytes: Uint8Array, chain: Chain): void {
  let { digest, partial, filled } = chain.at;
  let start = 0;
  let entries = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) {
      continue;
    }

    const marker = i + 1 < bytes.length ? bytes[i + 1] : 0;
    if (marker !== 0x23 && marker !== 0x24) {
      entries++;
      continue;
    }

    // A line of "#" and the entry after a block, or of "$" and the entry it ended at.
    let entry = 0;
    let j = i + 2;
    for (; j < bytes.length && bytes[j] !== 0x0a; j++) {
      entry = entry * 10 + bytes[j] - 0x30;
    }

    if (marker === 0x23) {
      digest = sha256Joined(digest, partial, bytes.subarray(start, i));
      partial = EMPTY;
      filled = 0;
      chain.marks.push({ entry, digest, partial, filled });
    } else {
      partial = joined(partial, bytes.subarray(start, i));
      filled += entries;
      chain.at = { entry, digest, partial, filled };
      if (chain.marks.length > KEPT) {
        chain.marks.splice(0, chain.marks.length - KEPT);
      }

      return;
    }

    entries = 0;
    start = j;
    i = j - 1;
  }

  throw new Error("codegen: a module key's log has no end");
}

/** `a` and then `b`, copied out of codegen's memory. */
function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (b.length === 0) {
    return a;
  }

  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// The web's and node's, which this package declares itself (see index.ts).
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };
const ascii = new TextDecoder();
