# swf2es

Play SWF files in the browser, and compile their ActionScript bytecode to
modern JavaScript, either on load (JIT) or ahead of time (AOT) with the same
output.

> Early days: the repository layout and test harness are in place; the
> compiler is not written yet. See [docs/architecture.md](docs/architecture.md)
> for the design and the first milestone.

## Layout

```
packages/
  format/    SWF, ABC and AVM1 parsers
  codegen/   bytecode → ES modules, AssemblyScript → wasm (same output for JIT and AOT)
  runtime/   AS3/AS2 language runtime (avm2/, avm1/)
  player/    browser player: display list, playerglobal, renderers
  cli/       ahead-of-time compiler
oracle/      avmshell and Flash Player references
tests/       unit and conformance tests
docs/        design, references, benchmarks and roadmap
```

## Embedding the player

A page plays a SWF with a `Player` and draws it with a `PixiView` over a
Pixi renderer it makes itself:

```ts
const renderer = await autoDetectRenderer({
  preference: "webgl",
  width: player.width,
  height: player.height,
  background: player.background,
  // Required for blend modes: they read what is below from the back buffer,
  // and without it draw as normal (the view warns once). It costs one
  // full-screen copy a frame on the GPU.
  useBackBuffer: true,
});
const view = new PixiView(renderer);
const unbind = view.bindPointer(player); // mouse input, until unbind()
const unbindKeys = bindKeyboard(player, window); // keys, and typing into the SWF's fields
await player.start();
let drawn = -1;
// Each animation frame: play what the time is worth, and draw only when
// `changes` moved: a frame ran, a key, a pointer event that changes what
// shows, updateAfterEvent, or a call from the page into the SWF; the
// frames between would draw the same picture.
player.advance(elapsedMs);
if (player.changes !== drawn) {
  drawn = player.changes;
  view.render(player.stage);
}
```

`Scripting` runs the SWF's ActionScript 3 and needs `builtin.abc` and
`playerglobal.abc`, which the host loads (`scripting.loadLibraries`);
Adobe's `playerglobal.abc` is not part of this repository.

## Development

```sh
git submodule update --init   # avmplus (Tamarin tests) and as3pb
pnpm install
pnpm build
pnpm check       # Biome: formatting and lint (pnpm format fixes them)
pnpm typecheck   # tests and scripts (packages are checked by build)
pnpm test        # needs podman or docker for the avmshell oracle, and Chrome for the player
pnpm tamarin     # the Tamarin acceptance tests in avmshell and swf2es
```

Formatting and linting use [Biome](https://biomejs.dev), installed with the
other dev dependencies. VS Code suggests its extension on opening the repo
and formats on save.

Node 24 is the default: tests and scripts are `.ts` files that node runs
directly. Deno works too once the packages are built, for example
`deno test -A --no-check` in `tests/unit`; its type-checker uses its own lib
settings, so type-checking stays with `pnpm typecheck`.

## Contributing

See [AGENTS.md](AGENTS.md) for the commands, rules and code style (written
for coding agents, and just as true for people).

## License

Apache-2.0
