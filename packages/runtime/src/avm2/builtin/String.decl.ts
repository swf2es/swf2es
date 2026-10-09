import type { ClassDecl } from "./declare.js";

export const StringDecl = {
  name: "String",
  super: "Object",
  sealed: true,
  final: true,
  init: { params: [["*", ["string", ""]]], native: true },
  classInit: { avmplus: true },
  static: [
    { const: "length", type: "int", value: ["int", 1] },
    { method: "AS3::fromCharCode", final: true, returns: "String", rest: true, native: true },
    {
      method: "private::_match",
      final: true,
      params: ["String", "*"],
      returns: "Array",
      native: true,
    },
    {
      method: "private::_replace",
      final: true,
      params: ["String", "*", "*"],
      returns: "String",
      native: true,
    },
    {
      method: "private::_search",
      final: true,
      params: ["String", "*"],
      returns: "int",
      native: true,
    },
    {
      method: "private::_split",
      final: true,
      params: ["String", "*", "uint"],
      returns: "Array",
      native: true,
    },
  ],
  instance: [
    { get: "length", returns: "int", native: true },
    {
      method: "private::_indexOf",
      params: ["String", ["int", ["int", 0]]],
      returns: "int",
      native: true,
    },
    {
      method: "AS3::indexOf",
      params: [
        ["String", ["string", "undefined"]],
        ["Number", ["int", 0]],
      ],
      returns: "int",
      native: true,
    },
    {
      method: "private::_lastIndexOf",
      params: ["String", ["int", ["int", 2147483647]]],
      returns: "int",
      native: true,
    },
    {
      method: "AS3::lastIndexOf",
      params: [
        ["String", ["string", "undefined"]],
        ["Number", ["int", 2147483647]],
      ],
      returns: "int",
      native: true,
    },
    { method: "AS3::charAt", params: [["Number", ["int", 0]]], returns: "String", native: true },
    {
      method: "AS3::charCodeAt",
      params: [["Number", ["int", 0]]],
      returns: "Number",
      native: true,
    },
    { method: "AS3::concat", returns: "String", rest: true, native: true },
    {
      method: "AS3::localeCompare",
      params: [["*", ["undefined", null]]],
      returns: "int",
      native: true,
    },
    { method: "AS3::match", params: [["*", ["undefined", null]]], returns: "Array", native: true },
    {
      method: "AS3::replace",
      params: [
        ["*", ["undefined", null]],
        ["*", ["undefined", null]],
      ],
      returns: "String",
      native: true,
    },
    { method: "AS3::search", params: [["*", ["undefined", null]]], returns: "int", native: true },
    {
      method: "private::_slice",
      params: [
        ["int", ["int", 0]],
        ["int", ["int", 2147483647]],
      ],
      returns: "String",
      native: true,
    },
    {
      method: "AS3::slice",
      params: [
        ["Number", ["int", 0]],
        ["Number", ["int", 2147483647]],
      ],
      returns: "String",
      native: true,
    },
    {
      method: "AS3::split",
      params: [
        ["*", ["undefined", null]],
        ["*", ["double", 4294967295]],
      ],
      returns: "Array",
      native: true,
    },
    {
      method: "private::_substring",
      params: [
        ["int", ["int", 0]],
        ["int", ["int", 2147483647]],
      ],
      returns: "String",
      native: true,
    },
    {
      method: "AS3::substring",
      params: [
        ["Number", ["int", 0]],
        ["Number", ["int", 2147483647]],
      ],
      returns: "String",
      native: true,
    },
    {
      method: "private::_substr",
      params: [
        ["int", ["int", 0]],
        ["int", ["int", 2147483647]],
      ],
      returns: "String",
      native: true,
    },
    {
      method: "AS3::substr",
      params: [
        ["Number", ["int", 0]],
        ["Number", ["int", 2147483647]],
      ],
      returns: "String",
      native: true,
    },
    { method: "AS3::toLowerCase", returns: "String", native: true },
    { method: "AS3::toLocaleLowerCase", returns: "String", native: true },
    { method: "AS3::toUpperCase", returns: "String", native: true },
    { method: "AS3::toLocaleUpperCase", returns: "String", native: true },
    { method: "AS3::toString", returns: "String", native: true },
    { method: "AS3::valueOf", returns: "String", native: true },
  ],
} as const satisfies ClassDecl;
