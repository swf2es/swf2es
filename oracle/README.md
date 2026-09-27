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
