// What a host gives a runtime when it makes one, and what it does without.

import type { Abc, CompileUnit } from "./descriptors.js";
import type { SharedBytesMemory } from "./natives/bytearray.js";
import type { SyncInit, SyncMemory } from "./natives/sync.js";
import type { Runtime } from "./runtime.js";

export interface RuntimeOptions {
  /** Where trace and print write a line. */
  print?: (line: string) => void;
  /**
   * Behave as the debugger player: error messages carry avmplus' text
   * ("Error #1009: Cannot access ..."), and System.isDebugger is true. By
   * default they are the release player's and avmshell's, "Error #1009".
   */
  debugger?: boolean;
  /**
   * An ABC compiled for avmshell's Domain.loadBytes, which runs it at once:
   * its module, or the VerifyError it was rejected with. The host compiles
   * it, as the runtime does not include the compiler, into the domain
   * `unit` names, with its findings; without it loadBytes is unsupported.
   * Each module it evaluates needs a script of its own in stacks, a
   * sourceURL comment, for Domain.currentDomain to find its code (see
   * Runtime.codeDomain).
   */
  compileAbc?: (abc: Uint8Array, unit: CompileUnit) => ((rt: Runtime) => Abc) | number;
  /** Where avmshell's File reads and writes: by default in memory, empty at the start. */
  files?: ShellFiles;
  /**
   * The SWF version whose behaviour avmplus keeps where it changed (its
   * BugCompatibility): avmshell's, 31, by default. A player sets its main
   * SWF's.
   */
  swfVersion?: number;
  /**
   * The API version of user code, which the host resets codegen with too:
   * Flash Player's, format's API_VERSION, by default; AIR's,
   * AIR_API_VERSION, for an AIR host; one of neither series is a
   * RangeError (checkApiVersion). What the
   * runtime looks up by a string, as getDefinitionByName, JSON and AMF
   * do, and what describeType lists, is what code of this version sees.
   */
  apiVersion?: number;
  /**
   * What starts avmshell's background workers, each on a thread of its
   * own; without it a Worker can be made but not started.
   */
  workers?: ShellWorkerHost;
  /** The background worker this runtime runs, as its host's thread was given it; by default the primordial. */
  worker?: ShellWorkerInit;
  /**
   * The memory this runtime's Mutexes and Conditions live in, shared with
   * the other workers of its primordial, and the worker it runs: by
   * default, for avmshell's workers, worker's; else memory of its own, as
   * the primordial's (natives/sync.ts).
   */
  sync?: SyncInit;
}

/** Starts the threads of avmshell's background workers. */
export interface ShellWorkerHost {
  /**
   * Start a thread that runs `init`'s worker: a runtime made with
   * `worker: init`, in which init.code runs as avmshell runs an ABC, or,
   * when it is null, the ABCs the primordial was given, as
   * createWorkerFromPrimordial has them. What it prints goes where the
   * primordial's does.
   */
  start(init: ShellWorkerInit): ShellThread;
  /**
   * Make a shareable ByteArray's memory known to every thread of the
   * primordial's, those started later too, before a shared property names
   * it; without it, one is shared only with this thread.
   */
  share?(memory: SharedBytesMemory): void;
  /** The memory another thread shared by `id`, or undefined if it has not come. */
  shared?(id: number): SharedBytesMemory | undefined;
}

export interface ShellThread {
  /** Stop the thread, wherever its code is; what it gives resolves once the thread has stopped. */
  terminate(): Promise<unknown> | undefined;
}

/** What a background worker's thread is given, which crosses to it as it is (structured clone). */
export interface ShellWorkerInit {
  /** The worker's number among those its primordial made, 0 being the primordial. */
  id: number;
  memory: ShellWorkersMemory;
  /** The ABC it runs, or null for the primordial's. */
  code: Uint8Array | null;
}

/** The memory the workers share: their states and parents, and their shared properties. */
export interface ShellWorkersMemory {
  control: ArrayBuffer | SharedArrayBuffer;
  table: ArrayBuffer | SharedArrayBuffer;
  /** Their Mutexes and Conditions. */
  sync: SyncMemory;
}

/** avmshell's file system, as its File sees it. */
export interface ShellFiles {
  /** A file's bytes, or null if it cannot be opened. */
  read(name: string): Uint8Array | null;
  /** Whether the file could be written. */
  write(name: string, bytes: Uint8Array): boolean;
}

/** Files that live as long as the runtime. */
export function memoryFiles(): ShellFiles {
  const files = new Map<string, Uint8Array>();
  return {
    read: (name) => files.get(name) ?? null,
    write: (name, bytes) => {
      files.set(name, bytes.slice());
      return true;
    },
  };
}

/** Where output goes by default: the host's console. */
export function defaultPrint(line: string): void {
  (globalThis as { console?: { log(line: string): void } }).console?.log(line);
}
