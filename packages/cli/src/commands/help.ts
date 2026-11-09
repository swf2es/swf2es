// swf2es help: the commands, or one command's usage.
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, COMMON_USAGE, type Command, parse } from "../args.js";
import { usageError } from "../output.js";
import { compile } from "./compile.js";
import { run } from "./run.js";

const help: Command = {
  name: "help",
  summary: "show the commands, or a command's usage",
  usage: `usage: swf2es help [command]

Shows the commands, or how to run one.

options:
${COMMON_USAGE}`,
  async main(argv) {
    const parsed = parse(help, () =>
      parseArgs({ args: argv, allowPositionals: true, options: COMMON_OPTIONS }),
    );
    if (!parsed) {
      return;
    }

    const { positionals } = parsed;
    if (positionals.length > 1) {
      usageError(`expected one command at most, got ${positionals.length}`);
    }

    if (positionals.length === 0) {
      console.log(usage());
      return;
    }

    const command = commands.get(positionals[0]);
    if (!command) {
      usageError(`no command ${positionals[0]}`);
    }

    console.log(command.usage);
  },
};

export const commands = new Map<string, Command>([compile, run, help].map((c) => [c.name, c]));

/** The command's own usage: its commands, and the bare form compile keeps. */
export function usage(): string {
  const width = Math.max(...[...commands.keys()].map((n) => n.length));
  const list = [...commands.values()].map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return `usage: swf2es <command> [options]
       swf2es <file.swf|file.abc> [options]   (as swf2es compile)

commands:
${list.join("\n")}

options:
${COMMON_USAGE}

Run swf2es help <command> for a command's options.`;
}
