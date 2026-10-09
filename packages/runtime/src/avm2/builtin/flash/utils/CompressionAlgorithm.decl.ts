import type { ClassDecl } from "../../declare.js";

export const CompressionAlgorithmClass = {
  name: "flash.utils::CompressionAlgorithm",
  super: "Object",
  sealed: true,
  final: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [
    { const: "ZLIB", type: "String", value: ["string", "zlib"] },
    { const: "DEFLATE", type: "String", value: ["string", "deflate"] },
    { const: "LZMA", type: "String", value: ["string", "lzma"] },
  ],
  instance: [],
} as const satisfies ClassDecl;
