# Oracles

Reference implementations that swf2es output is diffed against.

## avmshell

`oracle.ts` compiles `.as` files with ASC 2.0 and runs them in avmshell, the
avmplus (Tamarin) command-line shell. avmshell prints `trace()` output, and
that output is the expected result for AS3 language semantics.

Both tools come from the [CrossBridge](https://github.com/33TU/crossbridge)
image, pinned by digest in `oracle.ts`, and run with podman or docker (set
`SWF2ES_CONTAINER` to choose). CrossBridge builds a 32-bit avmshell with its
Alchemy/POSIX options on; the language core is standard Tamarin.

```sh
pnpm oracle:pull                          # once: pull the image
pnpm oracle tests/conformance/cases/int-coercion.as
```

`tests/conformance` uses the same module to get the expected output for every
case.

What ASC, gcc and abcdump produce is kept in a store shared by every checkout
on the machine, `~/.cache/swf2es/oracle` (under `$XDG_CACHE_HOME` if set, or
wherever `SWF2ES_ORACLE_CACHE` says), by a key that hashes the image, the
arguments and the inputs (`store.ts`). A new worktree takes its ABCs from
there instead of compiling them again, and starts no container when nothing
is left to compile or run. avmshell's runs are never stored. Deleting the
directory is always safe.

## avmplus

`avmplus/` is a submodule of [swf2es/avmplus](https://github.com/swf2es/avmplus),
a fork of the archived adobe/avmplus. It provides the Tamarin acceptance tests
(`avmplus/test/acceptance`), and is where patches to avmplus would go. It is
MPL-2.0: run it as a tool, but do not copy its source into the Apache-2.0
packages.

```sh
git submodule update --init
```

## Later

The Flash Player debug projector, for playerglobal behaviour (display list,
events, ByteArray).
