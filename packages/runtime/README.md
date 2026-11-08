# @swf2es/runtime

The language runtimes of [swf2es](https://github.com/swf2es/swf2es), which
the modules `@swf2es/codegen` compiles call into: AS3's (`avm2`, also
`@swf2es/runtime/avm2`) and AS1/2's (`avm1`, also `@swf2es/runtime/avm1`).
It holds the language alone, with no display list and no DOM or node
APIs, so it runs in browsers, workers and node. The player
([`@swf2es/player`](https://www.npmjs.com/package/@swf2es/player)) and the
`swf2es` command ([`@swf2es/cli`](https://www.npmjs.com/package/@swf2es/cli))
use it; most pages want
[`@swf2es/web`](https://www.npmjs.com/package/@swf2es/web).

```sh
npm install @swf2es/runtime
```

```js
import { builtinLibrary, createRuntime } from "@swf2es/runtime/avm2";

// avmplus' builtin.abc, which every AS3 runtime loads first.
console.log(builtinLibrary.length);
const runtime = createRuntime();
```

`runShell` in `@swf2es/cli` shows the runtime and the compiler together,
running ABCs as avmshell does.

Apache-2.0 ([LICENSE](LICENSE)); builtin.abc and the files translated
from avmplus are under the MPL-2.0, and parts are from Ruffle: see
[LICENSE.third-party](LICENSE.third-party).
