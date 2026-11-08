# @swf2es/cli

The `swf2es` command of [swf2es](https://github.com/swf2es/swf2es):
compiles a SWF's ActionScript ahead of time, to the very modules the
player would compile, and runs ABCs as avmshell does. It needs Node 22.18
or later.

```sh
npm install -g @swf2es/cli
```

```sh
swf2es movie.swf -o movie.swf2es --emit-libraries   # modules and a manifest.json
swf2es run program.abc                              # what it traces, on stdout
swf2es help [command]                               # the commands, or one's options
```

`compile` (the command when none is named) links against what the player
loads: avmplus' builtin.abc and swf2es's own playerglobal, and with
`--air` AIR's library too. `run` loads avmshell's builtin.abc and
shell_toplevel.abc first. All of them ship with the command; `--lib` names
others in their place. A page reads the modules with
`precompiledModules` from
[`@swf2es/player-hosts`](https://www.npmjs.com/package/@swf2es/player-hosts).

The package also exports the compiler and the runner for a host that
does without the command: `compileAhead`, `compileActionsAhead`,
`readInput` and `runShell`.

The [guide](https://swf2es.github.io/swf2es/docs/) has more.

Apache-2.0 ([LICENSE](LICENSE)); avmplus' shell_toplevel.abc under the
MPL-2.0, in [LICENSE.third-party](LICENSE.third-party).
