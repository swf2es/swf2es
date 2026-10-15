// The swf2es command's commands: which runs, the usage each shows, compile
// still taken for a bare input, and messages plain where colour cannot show.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../out/cli/commands/", import.meta.url));
const cli = fileURLToPath(new URL("../../../packages/cli/dist/main.js", import.meta.url));

/** The command run with `env` over a colourless environment, its output piped. */
function swf2es(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env };
  delete base.NO_COLOR;
  delete base.FORCE_COLOR;
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...base, ...env },
  });
}

test("help lists the commands, and shows each one's usage", () => {
  for (const args of [["help"], ["--help"], ["-h"]]) {
    const r = swf2es(args);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /^usage: swf2es <command>/);
    assert.match(r.stdout, /^ {2}compile {2}/m);
    assert.match(r.stdout, /^ {2}run {6}/m);
  }

  for (const [args, usage] of [
    [["help", "run"], /^usage: swf2es run <file\.abc>/],
    [["run", "--help"], /^usage: swf2es run <file\.abc>/],
    [["help", "compile"], /^usage: swf2es compile <file\.swf\|file\.abc>/],
    [["compile", "-h"], /^usage: swf2es compile/],
    [["help", "help"], /^usage: swf2es help/],
  ] as const) {
    const r = swf2es([...args]);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, usage);
  }
});

test("each command prints the version", () => {
  for (const args of [["-v"], ["--version"], ["run", "-v"], ["compile", "--version"]]) {
    const r = swf2es(args);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /^swf2es \d+\.\d+\.\d+\n$/);
  }
});

test("a mistake in the command line is status 2, with where to read the usage", () => {
  const none = swf2es([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^usage: swf2es <command>/);

  for (const [args, message, hint] of [
    [["rnu", "x.abc"], /no command rnu; to compile a file of that name/, "help"],
    [["help", "nope"], /no command nope/, "help"],
    [["help", "compile", "help"], /expected one command at most/, "help"],
    [["run"], /expected an ABC file to run/, "help run"],
    [["run", "--frobnicate", "x.abc"], /Unknown option '--frobnicate'/, "help run"],
    [["compile", "--frobnicate", "x.abc"], /Unknown option '--frobnicate'/, "help compile"],
    [["compile"], /expected one input file, got 0/, "help compile"],
    [["compile", "a.swf", "b.swf"], /expected one input file, got 2/, "help compile"],
  ] as const) {
    const r = swf2es([...args]);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^swf2es: error: /);
    assert.match(r.stderr, message);
    assert.match(r.stderr, new RegExp(`run swf2es ${hint} for usage\\n$`));
  }
});

test("a bare input, or options before it, is compile's, as before there were commands", () => {
  mkdirSync(out, { recursive: true });
  // An empty ABC: version 46.16, then twelve counts of nothing.
  const abc = new Uint8Array([16, 0, 46, 0, ...new Array(12).fill(0)]);
  writeFileSync(`${out}lib.abc`, abc);
  writeFileSync(`${out}ok.abc`, abc);
  const manifest = (dir: string, ...args: string[]) => {
    const r = swf2es([...args, "-o", `${out}${dir}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok\.abc: 1 module, \d+ bytes, compiled in \d+ ms/);
    return readFileSync(`${out}${dir}/manifest.json`, "utf8");
  };

  const lib = ["--lib", `${out}lib.abc`];
  const compiled = manifest("compile", "compile", `${out}ok.abc`, ...lib);
  assert.equal(manifest("bare", `${out}ok.abc`, ...lib), compiled);
  assert.equal(manifest("options", ...lib, `${out}ok.abc`), compiled);

  const quiet = swf2es(["-q", `${out}ok.abc`, "--lib", `${out}lib.abc`, "-o", `${out}quiet`]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
});

test("messages are coloured only where colour shows", () => {
  const csi = "\x1b[";
  const missing = ["compile", `${out}missing.swf`, "--lib", `${out}missing.abc`];
  // Piped, as here: plain, as for a file or a log.
  const plain = swf2es(missing);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /^swf2es: error: cannot read input .*missing\.swf: ENOENT\n$/);
  assert.ok(!plain.stderr.includes(csi), plain.stderr);

  // NO_COLOR, and a stream that is no terminal, are styleText's to honour:
  // FORCE_COLOR shows that the command leaves the choice to it.
  const forced = swf2es(missing, { FORCE_COLOR: "1" });
  assert.ok(forced.stderr.includes(`${csi}31m`), forced.stderr);
  assert.ok(!swf2es(missing, { NO_COLOR: "1" }).stderr.includes(csi));
});
