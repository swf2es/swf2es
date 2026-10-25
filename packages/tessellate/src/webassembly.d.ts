// ES2022 has no WebAssembly types or atob. This portable wrapper uses only
// the parts shared by browsers and node, without DOM or node types.
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
}

declare function atob(data: string): string;
