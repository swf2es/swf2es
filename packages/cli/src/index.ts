/** The ahead-of-time compiler as a library, for a host that compiles without the command. */
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
