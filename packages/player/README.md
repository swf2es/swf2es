# @swf2es/player

The SWF player of [swf2es](https://github.com/swf2es/swf2es): display
list, timeline, playerglobal (the `flash.*` classes) and AVM1, with the
view that drives its WebGL 2 renderer. A page wants
[`@swf2es/web`](https://www.npmjs.com/package/@swf2es/web), which embeds
the player in an element; this package is for a host of its own, such as
a SWF run headless in node.

```sh
npm install @swf2es/player
```

```js
import { readFile } from "node:fs/promises";
import { createCodegen } from "@swf2es/codegen";
import { builtinLibrary, Player, playerglobalLibrary, Scripting } from "@swf2es/player";

const wasm = await readFile(new URL(import.meta.resolve("@swf2es/codegen/codegen.wasm")));
const scripting = new Scripting(await createCodegen(await WebAssembly.compile(wasm)), {
  print: (line) => console.log(line), // trace()
});
await scripting.loadLibraries([builtinLibrary, playerglobalLibrary]);

const player = new Player(await readFile("movie.swf"), scripting);
await player.start(); // the document class and the first frame
player.tick(); // the next frame
player.destroy();
```

`@swf2es/player/libraries` gives the ABCs a SWF's ActionScript 3 links
against without the rest of the player: `builtinLibrary` (avmplus'
builtin.abc), `playerglobalLibrary`, swf2es's own playerglobal, and
`airLibrary`, AIR's additions, for an AIR application.

The [guide](https://swf2es.github.io/swf2es/docs/) has more.

Apache-2.0 ([LICENSE](LICENSE)); code from Ruffle and W3C, and its terms,
in [LICENSE.third-party](LICENSE.third-party).
