// The browser build's entry: @swf2es/web, which defines <swf2es-player>,
// told where codegen.wasm and the worker script lie, beside this file
// wherever it is served from.
// First, a side effect import that keeps its place: the URL is set before the asset's below is made.
import "./public-path.ts";
import codegen from "@swf2es/codegen/codegen.wasm";
import { configure } from "@swf2es/web";

// The worker is an entry of its own, not a module this one imports.
configure({ codegen, workerUrl: `${__webpack_public_path__}worker.js` });

export * from "@swf2es/web";
