# AS3 libraries

The player's own ActionScript, compiled by `pnpm as3` with ASC 1 in the
oracle's image and formatted by `pnpm as3:format`.

- `air/`: AIR's WebSocket client, which the oracle's playerglobal predates,
  loaded after playerglobal (`packages/player/src/playerglobal/air-library.ts`).
- `playerglobal/`: the player's playerglobal, which it ships as
  `playerglobalLibrary` (`packages/player/src/playerglobal/playerglobal-library.ts`).
  `pnpm as3:playerglobal` holds its API to Flash Player's and writes that
  file, and `SWF2ES_PLAYERGLOBAL=adobe` runs the tests on Flash Player's.

## playerglobal's sources

Every public definition of Flash Player's playerglobal has a file, made in
one of two ways:

- **From Ruffle** (ruffle-rs/ruffle at 4b7edd6a, MIT OR Apache-2.0, each file
  saying so): classes that are plain AS3 in Flash Player's playerglobal and
  in Ruffle's. Their API is held to Flash Player's: version marks, members
  Ruffle lacks (native, and marked as not implemented), constructors.
- **Skeletons** (`tools/abc-surface/as3.ts`): every other class, its API as
  Flash Player's playerglobal declares it, with no body taken from it. A
  method is `native`: the player's TypeScript natives under
  `packages/player/src/playerglobal/` implement it, or it is not supported yet.

The player's natives were written against Flash Player's playerglobal: a
method native there is native here too, and where Flash Player's has an AS3
body, ours needs one, written or taken from Ruffle.
