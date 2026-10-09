import type { ClassDecl } from "../../../declare.js";

export const ConditionClass: ClassDecl = {
  name: "flash.concurrent::Condition",
  api: 24,
  super: "Object",
  sealed: true,
  final: true,
  init: { params: ["flash.concurrent::Mutex"], avmplus: true },
  classInit: { avmplus: true },
  static: [{ get: "isSupported", final: true, returns: "Boolean", native: true }],
  instance: [
    { get: "mutex", returns: "flash.concurrent::Mutex", native: true },
    { method: "wait", params: [["Number", ["int", -1]]], returns: "Boolean", native: true },
    { method: "notify", returns: "void", native: true },
    { method: "notifyAll", returns: "void", native: true },
    { method: "private::ctor", params: ["flash.concurrent::Mutex"], returns: "void", native: true },
  ],
};
