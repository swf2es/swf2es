// What build.ts's asset rule makes of a WebAssembly file: its URL in the build.
declare module "*.wasm" {
  const url: string;
  export default url;
}

/** The URL Rspack's chunks and assets are found under (public-path.ts). */
declare let __webpack_public_path__: string;
/** A chunk's file by its id, relative to the module that imports it (public-path.ts). */
declare let __webpack_get_script_filename__: (chunk: string | number) => string;
