#!/usr/bin/env node
// The swf2es command: the first argument names a command, and any other
// first argument is compile's input, as before there were commands.
import { existsSync } from "node:fs";
import { printVersion } from "./args.js";
import { compile } from "./commands/compile.js";
import { commands, usage } from "./commands/help.js";
import { USAGE_ERROR, usageError } from "./output.js";

async function main(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;
  const command = commands.get(first);
  if (command) {
    await command.main(rest);
    return;
  }

  switch (first) {
    case undefined:
      process.stderr.write(`${usage()}\n`);
      process.exitCode = USAGE_ERROR;
      return;
    case "-h":
    case "--help":
      if (rest.length === 0) {
        console.log(usage());
        return;
      }

      break;
    case "-v":
    case "--version":
      if (rest.length === 0) {
        printVersion();
        return;
      }

      break;
  }

  // An option before the input, as `swf2es -o dir file.swf`, is compile's
  // too; a word that is no command nor a file is taken for a mistyped command.
  if (first.startsWith("-") || /[./\\]/.test(first) || existsSync(first)) {
    await compile.main(argv);
    return;
  }

  usageError(`no command ${first}; to compile a file of that name, swf2es compile ${first}`);
}

await main(process.argv.slice(2));
