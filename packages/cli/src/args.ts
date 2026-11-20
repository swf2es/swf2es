// What every command shares of its command line: the options all take,
// and a mistake in it reported as a usage error.
import { COMPILER_VERSION } from "@swf2es/codegen";
import { usageError } from "./output.js";

export interface Command {
  name: string;
  /** One line for the list of commands. */
  summary: string;
  usage: string;
  main(argv: string[]): Promise<void>;
}

/** The options every command takes, which parseArgs' options spread. */
export const COMMON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export const COMMON_USAGE = `  -h, --help           show this
  -v, --version        print the compiler's version`;

export function printVersion(): void {
  console.log(`swf2es ${COMPILER_VERSION}`);
}

/**
 * `command`'s arguments as `parse` reads them, a mistake in them a usage
 * error; null once -h or -v has been answered, and the command is done.
 */
export function parse<T extends { values: { help?: boolean; version?: boolean } }>(
  command: Command,
  read: () => T,
): T | null {
  let parsed: T;
  try {
    parsed = read();
  } catch (e) {
    usageError((e as Error).message, command.name);
  }

  if (parsed.values.help) {
    console.log(command.usage);
    return null;
  }

  if (parsed.values.version) {
    printVersion();
    return null;
  }

  return parsed;
}

/**
 * --api's value, as the player's apiVersion takes it: "latest" (the
 * default), "root", or a SWF version, a whole number from 1; a usage error
 * of `command`'s for anything else, and for "root" where `root` is false.
 */
export function apiVersionArgument(
  value: string | undefined,
  command: string,
  root = true,
): "latest" | "root" | number {
  const word = (value ?? "latest").trim().toLowerCase();
  if (word === "latest" || (root && word === "root")) {
    return word;
  }

  if (/^\d+$/.test(word) && Number(word) >= 1) {
    return Number(word);
  }

  usageError(
    `--api takes ${root ? "root, latest" : "latest"} or a SWF version, not ${JSON.stringify(value)}`,
    command,
  );
}
