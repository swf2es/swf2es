// What a host gives a runtime when it makes one, and what it does without.

import type { Abc, CompileUnit } from "./descriptors.js";
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
