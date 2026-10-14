// What the command says about itself on stderr. styleText colours only a
// terminal that takes colour: not with NO_COLOR, nor when stderr is a pipe
// or a file, unless FORCE_COLOR asks.
import { styleText } from "node:util";

/** The exit status for a mistake in how the command was run. */
export const USAGE_ERROR = 2;

const say = (label: string, color: "red" | "yellow", message: string) => {
  const head = styleText(["bold", color], `${label}:`, { stream: process.stderr });
  process.stderr.write(`swf2es: ${head} ${message}\n`);
};

export function warn(message: string): void {
  say("warning", "yellow", message);
}

/** Say what went wrong, and a hint on another line if there is one, and exit. */
export function fail(message: string, status = 1, hint?: string): never {
  say("error", "red", message);
  if (hint) {
    process.stderr.write(`${styleText("dim", hint, { stream: process.stderr })}\n`);
  }

  process.exit(status);
}

/** A mistake in the command line, with where to read how to run it. */
export function usageError(message: string, command?: string): never {
  fail(message, USAGE_ERROR, `run swf2es help${command ? ` ${command}` : ""} for usage`);
}
