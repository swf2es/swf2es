// The ES2022 lib has no WebAssembly types, this package deliberately loads
// neither DOM nor node types, and @types/node does not declare them either.
// These are the parts the wrapper, the asc bindings and the tests use;
// consumers get the real ones from their own environment.
declare namespace WebAssembly {
  interface Module {}
  interface ModuleImportDescriptor {
    module: string;
    name: string;
    kind: "function" | "global" | "memory" | "table" | "tag";
  }
  var Module: {
    imports(module: Module): ModuleImportDescriptor[];
  };
  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  function instantiate(module: Module, imports?: object): Promise<Instance>;
}
