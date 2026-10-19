import { createCodegen } from "../../packages/codegen/dist/index.js";
import { Avm1 } from "../../packages/player/dist/avm1/avm1.js";
import type { ExternalInterfaceHost } from "../../packages/player/dist/hosts.js";
import { Player } from "../../packages/player/dist/player.js";
import { Scripting } from "../../packages/player/dist/scripting.js";

export type Kind = "avm1" | "avm2";

export async function boot(kind: Kind, host: ExternalInterfaceHost, print: (s: string) => void) {
  const codegen = await createCodegen(
    await WebAssembly.compile(await (await fetch("/codegen/codegen.wasm")).arrayBuffer()),
  );
  const bytes = new Uint8Array(await (await fetch(`/experiment/${kind}.swf`)).arrayBuffer());
  const options = {
    externalInterface: host,
    audio: null,
    print,
    onUncaught(error: unknown) {
      print(`uncaught:${String(error)}`);
    },
  };
  let player: Player;
  if (kind === "avm1") {
    player = new Player(bytes, null, new Avm1(codegen, options));
  } else {
    const scripting = new Scripting(codegen, options);
    const libraries = await Promise.all(
      ["builtin", "playerglobal-swf2es"].map(
        async (name) => new Uint8Array(await (await fetch(`/libraries/${name}.abc`)).arrayBuffer()),
      ),
    );
    await scripting.loadLibraries(libraries);
    player = new Player(bytes, scripting);
  }

  await player.start();
  return player;
}
