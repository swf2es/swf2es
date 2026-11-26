// Loaded before each test file (package.json): with SWF2ES_CHECKED, as
// `pnpm test:checked` sets it, the player checks its own shortcuts too, and
// the compiler's tests run on its poison build (codegen/testing-module.ts).
import { Scripting } from "../../packages/player/dist/scripting.js";

if (process.env.SWF2ES_CHECKED) {
  Scripting.checkRounds = true;
  Scripting.checkPicks = true;
}
