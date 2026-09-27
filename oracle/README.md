# Oracles

Reference implementations that swf2es output is diffed against.

- `avmshell/` — the avmplus (Tamarin) command-line shell. It runs `.abc` files
  headlessly and prints `trace()` output. This is the oracle for AS3 language
  semantics. Binaries come from release assets of the `swf2es/avmplus` fork,
  pinned in `avmshell/fetch.mjs`, so CI does not rebuild Tamarin.
- `tamarin/` — the Tamarin acceptance tests (fetched, not committed).
- `flash/` — later: the Flash Player debug projector, for playerglobal
  behaviour (display list, events, ByteArray, …).
