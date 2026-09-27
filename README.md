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
  codegen/   bytecode → ES modules (same output for JIT and AOT)
  runtime/   AS3/AS2 language runtime (avm2/, avm1/)
  player/    browser player: display list, playerglobal, renderers
  cli/       ahead-of-time compiler
oracle/      avmshell and Flash Player references
tests/       unit and conformance tests
docs/        design notes
```

## Development

```sh
pnpm install
pnpm build
pnpm lint:deps   # package boundary rules
pnpm test
```

## License

Apache-2.0
