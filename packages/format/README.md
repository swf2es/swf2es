# @swf2es/format

The parsers of [swf2es](https://github.com/swf2es/swf2es): the SWF
container and its tags (shapes, fonts, text, bitmaps, sounds, buttons,
filters), DoABC's bytes, AVM1 action blocks, Pixel Bender bytecode, AIR
descriptors and the ZIP archives AIR packages are. No DOM or node APIs.
The compiler and the player use it; most pages want
[`@swf2es/web`](https://www.npmjs.com/package/@swf2es/web).

```sh
npm install @swf2es/format
```

```js
import { readFile } from "node:fs/promises";
import { readSwf } from "@swf2es/format";

const swf = readSwf(new Uint8Array(await readFile("movie.swf")));
console.log(swf.header.version, swf.frameRate, swf.frameCount, swf.tags.length);
```

Apache-2.0 ([LICENSE](LICENSE)); parts from Ruffle, and its terms, in
[LICENSE.third-party](LICENSE.third-party).
