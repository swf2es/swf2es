// swf2es run: ABCs run as avmshell runs them, each compiled by codegen and
// loaded into the runtime, their trace and print on stdout.
import { readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createCodegen } from "@swf2es/codegen";
import { createRuntime, type ShellFiles } from "@swf2es/runtime/avm2";
import { InputError, RejectedError, readInput } from "../aot.js";
import { COMMON_OPTIONS, COMMON_USAGE, type Command, parse } from "../args.js";
import { codegenModule, defaultLibraries, read, readLibraries } from "../files.js";
import { fail, usageError } from "../output.js";
import { runShell } from "../shell.js";
import { nodeShellThreads } from "../threads.js";

const USAGE = `usage: swf2es run <file.abc> [more.abc ...] [options]

Runs ABCs as avmshell does: its libraries first, their scripts run on
first use, then each ABC in the order given, in one domain, its entry
point run once it loads. What they trace and print goes to stdout. An ABC
rejected with a VerifyError, or an exception nothing catches, is printed
there too, as avmshell prints it, and ends the run; the ABCs after it do
not run. avmshell's File reads and writes in the working directory, and
its workers run on threads of their own, stopped when the ABCs end.

options:
  --lib <file.abc>     a library to load first, into the root domain, in
                       the order given; repeat for each. Default:
                       avmshell's builtin.abc and shell_toplevel.abc, from
                       the repository's oracle/avmplus/generated/, if there
${COMMON_USAGE}

exit status: 0 when every ABC ran to its end, 1 as avmshell's for a
VerifyError or an uncaught exception, 2 for a mistake in the command line
or missing default libraries, and 1 for what stopped it besides (an
unreadable input or library, a SWF, a library rejected, an error of
swf2es' own), said on stderr`;

const SWF_SIGNATURES = new Set(["FWS", "CWS", "ZWS"]);

const OPTIONS = {
  lib: { type: "string", multiple: true },
  ...COMMON_OPTIONS,
} as const;

/** avmshell's File: the working directory's files, as it reads and writes them. */
function workingFiles(): ShellFiles {
  return {
    read(name) {
      // One it cannot open, unreadable or a directory, avmshell's File cannot
      // open either: Error #1500 for the ABC to catch, not swf2es failing.
      try {
        const path = resolve(name);
        return statSync(path).isFile() ? new Uint8Array(readFileSync(path)) : null;
      } catch {
        return null;
      }
    },
    write(name, bytes) {
      try {
        writeFileSync(resolve(name), bytes);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const run: Command = {
  name: "run",
  summary: "run ABCs as avmshell does, printing what they trace",
  usage: USAGE,
  async main(argv) {
    const parsed = parse(run, () =>
      parseArgs({ args: argv, allowPositionals: true, options: OPTIONS }),
    );
    if (!parsed) {
      return;
    }

    const { values, positionals } = parsed;
    if (positionals.length === 0) {
      usageError("expected an ABC file to run", "run");
    }

    const libraries =
      values.lib ??
      defaultLibraries(
        ["builtin.abc", "shell_toplevel.abc"],
        ["oracle/avmplus/generated/", "tests/libraries/out/", "tests/conformance/out/lib/"],
        "no --lib given, and no builtin.abc and shell_toplevel.abc in the repository's\n" +
          "oracle/avmplus/generated/. Pass avmshell's libraries with --lib, or check out the\n" +
          "submodule: git submodule update --init oracle/avmplus",
      );

    const abcs: { name: string; abc: Uint8Array }[] = [];
    for (const file of positionals) {
      const abc = await read(file, "input");
      if (SWF_SIGNATURES.has(String.fromCharCode(...abc.subarray(0, 3)))) {
        fail(`${file}: a SWF; run takes ABCs, as a SWF's code needs the player's playerglobal`);
      }

      try {
        readInput(abc);
      } catch (e) {
        fail(e instanceof InputError ? `${file}: ${e.message}` : String(e));
      }

      abcs.push({ name: basename(file, extname(file)), abc });
    }

    const libs = await readLibraries(libraries);
    const codegen = await codegenModule();
    const compiler = await createCodegen(codegen);
    // A line at a time, as avmshell's console writes it; its workers' threads write their own.
    const print = (line: string) => writeSync(1, `${line}\n`);
    const threads = nodeShellThreads({ codegen, libraries: libs, abcs });
    try {
      process.exitCode = await runShell(libs, abcs, {
        compiler,
        createRuntime,
        print,
        files: workingFiles(),
        workers: threads.host,
      });
      await threads.close();
    } catch (e) {
      if (e instanceof RejectedError) {
        fail(e.message);
      }

      fail(`swf2es itself failed: ${(e as Error).stack ?? e}`);
    }
  },
};
