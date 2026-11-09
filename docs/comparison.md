# swf2es, Flash and Ruffle

Where swf2es is ahead of Flash Player and Ruffle, where it is behind, and
how that was measured. Draft: the measured sections fill in from
`tests/bench/players.ts --json` sessions, one per machine and GPU; until
then they say what each will show.

## The players

| Player | Version | How it runs here |
|---|---|---|
| swf2es | the commit a session names | Chrome, headless; scripts in the tests' page, drawing and startup in the browser build's `<swf2es-player>` |
| Ruffle | 0.7.1, its self-hosted web build | Chrome, headless |
| Flash Player 32 | 32.0.0.465, the last | Windows release projector under Wine |
| Flash Player 11.5 | 11.5.502.146 | Windows release projector under Wine |
| AIR | the SDK's adl, `-nodebug` | scripts only: it is not Flash Player |

Flash Player 11.5 is the baseline for Flash at its best. Later players
ran some code slower in single runs before these sessions: a Pixel Bender
fill about seven times slower from 11.9, with the JIT gone after 11.7,
and as3pb's ByteArray and AMF3 encoding about twice and 1.7 times slower
in 32. The sessions will say how much of that holds. The projectors draw on the CPU, as
Flash's display list always did. The browsers draw on the GPU that a
session names: the same scenes on an integrated and a discrete one.

## Measured

Each benchmark is a SWF that times itself, the same bytes in every
player (`tests/bench/players.ts`); every run is kept, and the tables give
medians.

- **ActionScript:** enumeration, Dictionary access, Vector and Array
  access, as3pb (protobuf over ByteArray and domain memory, AMF3, JSON),
  and LZ4 in C as Crossbridge builds it. Milliseconds per section.
- **Drawing:** vectors, bitmaps, filters, text, graphics redrawn every
  frame, and a Pixel Bender fill computed anew each frame (`beginShaderFill`,
  at three sizes), each at three loads, at 60 frames a second. Fps and frame times
  (p50, p95, p99, worst) for each level, and memory where a player tells
  it. Not uncapped: swf2es runs up to five SWF frames for each display
  frame when a SWF is faster than the display, so a faster rate would
  count frames not drawn.
- **CPU:** the share of a core the player's processes take to keep a
  still stage and a light animation (a hundred shapes) at 60 frames a
  second: a browser's page, GPU and other processes, or Wine's; the GPU's
  own work is not in it.
- **Not yet:** Stage3D. swf2es draws it through a surface the page gives
  it (the site's `stage3d.ts`), which the browser build does not include,
  so a scene of it needs that in the benchmark's page first.
- **Startup:** from making the player to a SWF's first line, cold and
  warm, for a SWF of nothing and one of as3pb's classes; and the bytes of
  the player's files a page fetched, raw, gzipped and in brotli.

Results: to come.

## Correctness

Measured against Flash and avmshell, not against Ruffle or Flash
measured by us alone:

- **Ruffle's test corpus:** swf2es passes 1,416 of the 1,984 tests it
  runs (71.4%): AVM1 590 of 715 (82.5%), AVM2 820 of 1,252 (65.5%),
  timeline 6 of 17 (35.3%), at dev 12684d3d. These are Ruffle's own
  tests, its expected output checked against Flash, so Ruffle passes
  nearly all of them by construction: the figure is how close swf2es is
  to Flash on them, not a match between the two.
- **Tamarin's acceptance tests:** swf2es ends 2,530 of 2,566 as avmshell
  does (98.6%), 2026-10-29 ([coverage.md](coverage.md)).
- **Its own player cases:** 372 SWFs whose frames and traces must be as
  Flash's under adl (`tests/player/run.ts`), and the plugin's where it
  differs from AIR for older web content.

## Features

| | swf2es | Flash Player | Ruffle 0.7.1 |
|---|---|---|---|
| AVM1 | yes, compiled to JavaScript | yes | to check |
| AS3 | yes, compiled to JavaScript, in the browser or ahead of time | yes, JIT | to check |
| Stage3D | experimental | yes | to check |
| Pixel Bender | on the GPU: filters, blends, fills; ShaderJob on the CPU | yes; JIT until 11.7 | to check |
| Workers | yes, on Web Workers | yes | to check |
| AIR's APIs | in the desktop app and in a page: files, encrypted store, WebSocket | in AIR, not Flash Player | to check |
| Sockets | through a WebSocket proxy | yes | through a WebSocket proxy |
| Video (NetStream, embedded) | no | yes | to check |
| Text engine (FTE, TLF) | no | yes | to check |
| Native extensions | no | in AIR | to check |

## Known gaps

- **Video:** `Video` is a box of its size; nothing plays in it.
  NetStream with H.264 through WebCodecs is queued
  ([roadmap.md](roadmap.md)).
- **The timeline corpus:** 35% of its tests.
- **Text:** no FTE or TLF; anti-aliasing of device and embedded text
  differs from Flash's; hairlines are anti-aliased where Flash snaps
  them to a pixel.
- **Native extensions:** none yet.
- **Browsers:** tuned for V8; slower in Firefox, about 30% on as3pb.

## Running it

```sh
node tests/bench/players.ts --runs 5 --json session.json \
  --ruffle DIR --flash32 flashplayer_32_sa.exe --flash11 flashplayer_11_sa.exe \
  --wine "flatpak run --filesystem=home org.winehq.Wine"
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/intel_icd.x86_64.json \
  node tests/bench/players.ts ... --json intel.json drawing startup-hello startup-as3pb
```

Each session's JSON keeps every run's times and output, the commit, the
machine, each player's version and, for drawing, the GPU that drew.
