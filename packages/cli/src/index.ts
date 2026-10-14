/** The ahead-of-time compiler and avmshell's way of running ABCs as a library, for a host that does without the command. */
export {
  type AbcInput,
  API_VERSION,
  compileAhead,
  type Input,
  type Module,
  RejectedError,
  readInput,
  sha256,
} from "./aot.js";
export {
  evaluateModule,
  runShell,
  type ShellCompiler,
  type ShellLibrary,
  type ShellModule,
  type ShellOptions,
  shellDomain,
} from "./shell.js";
