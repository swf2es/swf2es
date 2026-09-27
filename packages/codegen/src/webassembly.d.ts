// The ES2022 lib has no WebAssembly types, and this package deliberately loads
// neither DOM nor node types. These are the parts the wrapper and the asc
// bindings use; consumers get the real ones from their own environment.
declare namespace WebAssembly {
  interface Module {}
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  function instantiate(module: Module, imports?: object): Promise<Instance>;
}
