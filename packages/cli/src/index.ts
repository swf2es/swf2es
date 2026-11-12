/**
 * The ahead-of-time compiler, avmshell's way of running ABCs and the
 * declarations of ABCs' classes as a library, for a host that does without
 * the command.
 */
export {
  type AbcInput,
  type ActionsModule,
  AIR_API_VERSION,
  API_VERSION,
  type Avm1Input,
  compileActionsAhead,
  compileAhead,
  type Input,
  type Module,
  RejectedError,
  readInput,
  sha256,
} from "./aot.js";
export { as3Declarations, type DeclarationsOptions, type DeclaredLibrary } from "./as3-types.js";
export {
  evaluateModule,
  runShell,
  type ShellCompiler,
  type ShellLibrary,
  type ShellModule,
  type ShellOptions,
  shellDomain,
} from "./shell.js";
export { nodeShellThreads, type ShellThreads, type ShellThreadsOptions } from "./threads.js";
