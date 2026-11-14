// The browser build's entry: @swf2es/web, which defines <swf2es-player>,
// told where codegen.wasm and the worker scripts lie, beside this file
// wherever it is served from.
// First, a side effect import that keeps its place: the URL is set before the asset's below is made.
import "./public-path.ts";
import codegen from "@swf2es/codegen/codegen.wasm";
import { configure } from "@swf2es/web";

// The workers are entries of their own, not modules this one imports.
configure({
  codegen,
  workerUrl: `${__webpack_public_path__}worker.js`,
  compilerUrl: `${__webpack_public_path__}compiler.js`,
});

export * from "@swf2es/web";
