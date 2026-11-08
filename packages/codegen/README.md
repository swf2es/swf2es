# @swf2es/codegen

The compiler of [swf2es](https://github.com/swf2es/swf2es): ABC (AS3) and
AVM1 (AS1/2) bytecode to ES modules, written in AssemblyScript and built
to `codegen.wasm`. The same binary is the player's JIT and the `swf2es`
command's ahead-of-time compiler, so both give the same modules. Most pages
want [`@swf2es/web`](https://www.npmjs.com/package/@swf2es/web); the
command is [`@swf2es/cli`](https://www.npmjs.com/package/@swf2es/cli).

```sh
npm install @swf2es/codegen
```

```js
import { createCodegen } from "@swf2es/codegen";

const wasm = await WebAssembly.compileStreaming(
  fetch(import.meta.resolve("@swf2es/codegen/codegen.wasm")),
);
const codegen = await createCodegen(wasm); // a compiler, for one player
```

The module imports nothing but `env.abort`. `codegen.wasm` is also
exported as `@swf2es/codegen/codegen.wasm` for a bundler or an import map.

Apache-2.0 ([LICENSE](LICENSE)); AssemblyScript's notice, and Ruffle's
for the AVM1 decoder's readings, in [LICENSE.third-party](LICENSE.third-party).
