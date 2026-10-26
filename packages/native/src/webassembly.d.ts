// ES2022 has no WebAssembly types or atob, and this package loads neither
// DOM nor node types, as format, which uses it, does not. These are the
// parts the wrappers use; browsers and node both have them.
declare namespace WebAssembly {
  // biome-ignore lint/suspicious/noEmptyInterface: an opaque handle, like the real Module type
  interface Module {}
  var Module: {
    new (bytes: ArrayBufferView | ArrayBuffer): Module;
  };
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  var Instance: {
    new (module: Module, imports?: object): Instance;
  };
  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
}

declare function atob(data: string): string;
