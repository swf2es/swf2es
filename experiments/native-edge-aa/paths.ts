import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const here = fileURLToPath(new URL(".", import.meta.url));
export const out =
  resolve(process.env.SWF2ES_EDGE_AA_OUT ?? join(tmpdir(), "swf2es-native-edge-aa")) + sep;
