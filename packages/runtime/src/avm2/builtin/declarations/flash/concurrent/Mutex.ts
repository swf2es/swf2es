import type { ClassDecl } from "../../../declare.js";

export const MutexClass: ClassDecl = {
  name: "flash.concurrent::Mutex",
  api: 24,
  super: "Object",
  sealed: true,
  final: true,
  init: { avmplus: true },
  classInit: { avmplus: true },
  static: [{ get: "isSupported", final: true, returns: "Boolean", native: true }],
  instance: [
    { method: "lock", returns: "void", native: true },
    { method: "tryLock", returns: "Boolean", native: true },
    { method: "unlock", returns: "void", native: true },
    { method: "private::ctor", returns: "void", native: true },
  ],
};
