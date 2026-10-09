// builtin's scripts in the order they load, each with the definitions it
// makes (see declare.ts).

import { VectorClass } from "./__AS3__/vec/Vector.decl.js";
import { Vector$doubleClass } from "./__AS3__/vec/Vector$double.decl.js";
import { Vector$intClass } from "./__AS3__/vec/Vector$int.decl.js";
import { Vector$objectClass } from "./__AS3__/vec/Vector$object.decl.js";
import { Vector$uintClass } from "./__AS3__/vec/Vector$uint.decl.js";
import { ArgumentErrorClass } from "./ArgumentError.decl.js";
import { ArrayClass } from "./Array.decl.js";
import { BooleanClass } from "./Boolean.decl.js";
import { ClassClass } from "./Class.decl.js";
import { DateClass } from "./Date.decl.js";
import { DefinitionErrorClass } from "./DefinitionError.decl.js";
import type { ScriptDecl } from "./declare.js";
import { ErrorClass } from "./Error.decl.js";
import { EvalErrorClass } from "./EvalError.decl.js";
import { FunctionClass } from "./Function.decl.js";
import { ConditionClass } from "./flash/concurrent/Condition.decl.js";
import { MutexClass } from "./flash/concurrent/Mutex.decl.js";
import { EOFErrorClass } from "./flash/errors/EOFError.decl.js";
import { IllegalOperationErrorClass } from "./flash/errors/IllegalOperationError.decl.js";
import { IOErrorClass } from "./flash/errors/IOError.decl.js";
import { MemoryErrorClass } from "./flash/errors/MemoryError.decl.js";
import { DynamicPropertyOutputClass } from "./flash/net/DynamicPropertyOutput.decl.js";
import { IDynamicPropertyOutputClass } from "./flash/net/IDynamicPropertyOutput.decl.js";
import { IDynamicPropertyWriterClass } from "./flash/net/IDynamicPropertyWriter.decl.js";
import { ObjectEncodingClass } from "./flash/net/ObjectEncoding.decl.js";
import { ByteArrayClass } from "./flash/utils/ByteArray.decl.js";
import { CompressionAlgorithmClass } from "./flash/utils/CompressionAlgorithm.decl.js";
import { DictionaryClass } from "./flash/utils/Dictionary.decl.js";
import { IDataInputClass } from "./flash/utils/IDataInput.decl.js";
import { IDataInput2Class } from "./flash/utils/IDataInput2.decl.js";
import { IDataOutputClass } from "./flash/utils/IDataOutput.decl.js";
import { IDataOutput2Class } from "./flash/utils/IDataOutput2.decl.js";
import { IExternalizableClass } from "./flash/utils/IExternalizable.decl.js";
import { ObjectInputClass } from "./flash/utils/ObjectInput.decl.js";
import { ObjectOutputClass } from "./flash/utils/ObjectOutput.decl.js";
import { ProxyClass } from "./flash/utils/Proxy.decl.js";
import { intClass } from "./int.decl.js";
import { JSONClass } from "./JSON.decl.js";
import { MathClass } from "./Math.decl.js";
import { MethodClosureClass } from "./MethodClosure.decl.js";
import { NamespaceClass } from "./Namespace.decl.js";
import { NumberClass } from "./Number.decl.js";
import { ObjectClass } from "./Object.decl.js";
import { QNameClass } from "./QName.decl.js";
import { RangeErrorClass } from "./RangeError.decl.js";
import { ReferenceErrorClass } from "./ReferenceError.decl.js";
import { RegExpClass } from "./RegExp.decl.js";
import { SecurityErrorClass } from "./SecurityError.decl.js";
import { StringClass } from "./String.decl.js";
import { SyntaxErrorClass } from "./SyntaxError.decl.js";
import { TypeErrorClass } from "./TypeError.decl.js";
import { UninitializedErrorClass } from "./UninitializedError.decl.js";
import { URIErrorClass } from "./URIError.decl.js";
import { uintClass } from "./uint.decl.js";
import { VerifyErrorClass } from "./VerifyError.decl.js";
import { WalkerClass } from "./Walker.decl.js";
import { XMLClass } from "./XML.decl.js";
import { XMLListClass } from "./XMLList.decl.js";

export const scripts: ScriptDecl[] = [
  {
    init: { avmplus: true },
    traits: [
      {
        method: "flash.net::registerClassAlias",
        params: ["String", "Class"],
        returns: "void",
        native: true,
        meta: [["native", [["", "Toplevel::registerClassAlias"]]]],
      },
      {
        method: "flash.net::getClassByAlias",
        params: ["String"],
        returns: "Class",
        native: true,
        meta: [["native", [["", "Toplevel::getClassByAlias"]]]],
      },
    ],
  },
  { init: { avmplus: true }, traits: [] },
  {
    init: { avmplus: true },
    traits: [
      {
        class: MathClass,
        meta: [
          [
            "native",
            [
              ["cls", "MathClass"],
              ["classgc", "exact"],
              ["instance", "double"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: ErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "ErrorClass"],
              ["gc", "exact"],
              ["instance", "ErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: DefinitionErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "DefinitionErrorClass"],
              ["gc", "exact"],
              ["instance", "DefinitionErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: EvalErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "EvalErrorClass"],
              ["gc", "exact"],
              ["instance", "EvalErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: RangeErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "RangeErrorClass"],
              ["gc", "exact"],
              ["instance", "RangeErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: ReferenceErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "ReferenceErrorClass"],
              ["gc", "exact"],
              ["instance", "ReferenceErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: SecurityErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "SecurityErrorClass"],
              ["gc", "exact"],
              ["instance", "SecurityErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: SyntaxErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "SyntaxErrorClass"],
              ["gc", "exact"],
              ["instance", "SyntaxErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: TypeErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "TypeErrorClass"],
              ["gc", "exact"],
              ["instance", "TypeErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: URIErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "URIErrorClass"],
              ["gc", "exact"],
              ["instance", "URIErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: VerifyErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "VerifyErrorClass"],
              ["gc", "exact"],
              ["instance", "VerifyErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: UninitializedErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "UninitializedErrorClass"],
              ["gc", "exact"],
              ["instance", "UninitializedErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        class: ArgumentErrorClass,
        meta: [
          [
            "native",
            [
              ["cls", "ArgumentErrorClass"],
              ["gc", "exact"],
              ["instance", "ArgumentErrorObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      { class: IOErrorClass },
      { class: EOFErrorClass },
      { class: MemoryErrorClass },
      { class: IllegalOperationErrorClass },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: DateClass,
        meta: [
          [
            "native",
            [
              ["cls", "DateClass"],
              ["gc", "exact"],
              ["instance", "DateObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: RegExpClass,
        meta: [
          [
            "native",
            [
              ["cls", "RegExpClass"],
              ["gc", "exact"],
              ["instance", "RegExpObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: JSONClass,
        meta: [
          [
            "native",
            [
              ["cls", "JSONClass"],
              ["classgc", "exact"],
              ["methods", "auto"],
              ["construct", "none"],
            ],
          ],
          ["API", [["", "674"]]],
        ],
      },
      { class: WalkerClass },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: XMLClass,
        meta: [
          [
            "native",
            [
              ["cls", "XMLClass"],
              ["gc", "exact"],
              ["instance", "XMLObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: XMLListClass,
        meta: [
          [
            "native",
            [
              ["cls", "XMLListClass"],
              ["gc", "exact"],
              ["instance", "XMLListObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: QNameClass,
        meta: [
          [
            "native",
            [
              ["cls", "QNameClass"],
              ["gc", "exact"],
              ["instance", "QNameObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
    ],
  },
  { init: { avmplus: true }, traits: [{ class: IDataInputClass }] },
  { init: { avmplus: true }, traits: [{ class: IDataOutputClass }] },
  {
    init: { avmplus: true },
    traits: [
      {
        const: "flash.utils::flash_proxy",
        value: ["namespace", "namespace:http://www.adobe.com/2006/actionscript/flash/proxy"],
      },
      {
        class: ProxyClass,
        meta: [
          [
            "native",
            [
              ["cls", "ProxyClass"],
              ["gc", "exact"],
              ["instance", "ProxyObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: DictionaryClass,
        meta: [
          [
            "native",
            [
              ["cls", "DictionaryClass"],
              ["gc", "exact"],
              ["instance", "DictionaryObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
    ],
  },
  { init: { avmplus: true }, traits: [{ class: IDynamicPropertyOutputClass }] },
  { init: { avmplus: true }, traits: [{ class: IDynamicPropertyWriterClass }] },
  { init: { avmplus: true }, traits: [{ class: IExternalizableClass }] },
  {
    init: { avmplus: true },
    traits: [
      {
        class: ObjectEncodingClass,
        meta: [
          [
            "native",
            [
              ["cls", "ObjectEncodingClass"],
              ["gc", "exact"],
              ["methods", "auto"],
              ["construct", "none"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: MutexClass,
        meta: [
          [
            "native",
            [
              ["cls", "MutexClass"],
              ["instance", "MutexObject"],
              ["gc", "exact"],
            ],
          ],
          ["API", [["", "684"]]],
        ],
      },
      {
        class: ConditionClass,
        meta: [
          [
            "native",
            [
              ["cls", "ConditionClass"],
              ["instance", "ConditionObject"],
              ["gc", "exact"],
            ],
          ],
          ["API", [["", "684"]]],
        ],
      },
      {
        method: "avm2.intrinsics.memory::mfence",
        returns: "void",
        native: true,
        api: 24,
        meta: [
          ["native", [["", "ConcurrentMemory::mfence"]]],
          ["API", [["", "684"]]],
        ],
      },
      {
        method: "avm2.intrinsics.memory::casi32",
        params: ["int", "int", "int"],
        returns: "int",
        native: true,
        api: 24,
        meta: [
          ["native", [["", "ConcurrentMemory::casi32"]]],
          ["API", [["", "684"]]],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: ObjectInputClass,
        meta: [
          [
            "native",
            [
              ["cls", "ObjectInputClass"],
              ["gc", "exact"],
              ["instance", "ObjectInputObject"],
              ["methods", "auto"],
              ["construct", "native"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      { class: CompressionAlgorithmClass },
      { class: IDataInput2Class },
      { class: IDataOutput2Class },
      {
        class: ByteArrayClass,
        meta: [
          [
            "native",
            [
              ["cls", "ByteArrayClass"],
              ["gc", "exact"],
              ["instance", "ByteArrayObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: ObjectOutputClass,
        meta: [
          [
            "native",
            [
              ["cls", "ObjectOutputClass"],
              ["gc", "exact"],
              ["instance", "ObjectOutputObject"],
              ["methods", "auto"],
              ["construct", "native"],
            ],
          ],
        ],
      },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: DynamicPropertyOutputClass,
        meta: [
          [
            "native",
            [
              ["cls", "DynamicPropertyOutputClass"],
              ["gc", "exact"],
              ["instance", "DynamicPropertyOutputObject"],
              ["methods", "auto"],
              ["construct", "native"],
            ],
          ],
        ],
      },
    ],
  },
  {
    private: "builtin.as$0",
    init: { avmplus: true },
    traits: [
      { const: "AS3", value: ["namespace", "namespace:http://adobe.com/AS3/2006/builtin"] },
      {
        class: ObjectClass,
        meta: [
          [
            "native",
            [
              ["cls", "ObjectClass"],
              ["classgc", "exact"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: ClassClass,
        meta: [
          [
            "native",
            [
              ["cls", "ClassClass"],
              ["gc", "exact"],
              ["instance", "ClassClosure"],
              ["methods", "auto"],
              ["construct", "instance"],
            ],
          ],
        ],
      },
      {
        class: FunctionClass,
        meta: [
          [
            "native",
            [
              ["cls", "FunctionClass"],
              ["gc", "exact"],
              ["instance", "FunctionObject"],
              ["methods", "auto"],
              ["construct", "instance"],
            ],
          ],
        ],
      },
      {
        class: MethodClosureClass,
        meta: [
          [
            "native",
            [
              ["cls", "MethodClosureClass"],
              ["gc", "exact"],
              ["instance", "MethodClosure"],
              ["methods", "auto"],
              ["construct", "instance"],
            ],
          ],
        ],
      },
      {
        class: NamespaceClass,
        meta: [
          [
            "native",
            [
              ["cls", "NamespaceClass"],
              ["classgc", "exact"],
              ["instance", "Namespace"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: BooleanClass,
        meta: [
          [
            "native",
            [
              ["cls", "BooleanClass"],
              ["classgc", "exact"],
              ["instance", "bool"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: NumberClass,
        meta: [
          [
            "native",
            [
              ["cls", "NumberClass"],
              ["classgc", "exact"],
              ["instance", "double"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: intClass,
        meta: [
          [
            "native",
            [
              ["cls", "IntClass"],
              ["classgc", "exact"],
              ["instance", "int32_t"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: uintClass,
        meta: [
          [
            "native",
            [
              ["cls", "UIntClass"],
              ["classgc", "exact"],
              ["instance", "uint32_t"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: StringClass,
        meta: [
          [
            "native",
            [
              ["cls", "StringClass"],
              ["classgc", "exact"],
              ["instance", "String"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: ArrayClass,
        meta: [
          [
            "native",
            [
              ["cls", "ArrayClass"],
              ["gc", "exact"],
              ["instance", "ArrayObject"],
              ["methods", "auto"],
            ],
          ],
        ],
      },
      {
        method: "bugzilla",
        params: ["int"],
        returns: "Boolean",
        native: true,
        api: 52,
        meta: [
          ["API", [["", "712"]]],
          ["native", [["", "Toplevel::bugzilla"]]],
        ],
      },
      {
        method: "decodeURI",
        params: [["String", ["string", "undefined"]]],
        returns: "String",
        native: true,
        meta: [["native", [["", "Toplevel::decodeURI"]]]],
      },
      {
        method: "decodeURIComponent",
        params: [["String", ["string", "undefined"]]],
        returns: "String",
        native: true,
        meta: [["native", [["", "Toplevel::decodeURIComponent"]]]],
      },
      {
        method: "encodeURI",
        params: [["String", ["string", "undefined"]]],
        returns: "String",
        native: true,
        meta: [["native", [["", "Toplevel::encodeURI"]]]],
      },
      {
        method: "encodeURIComponent",
        params: [["String", ["string", "undefined"]]],
        returns: "String",
        native: true,
        meta: [["native", [["", "Toplevel::encodeURIComponent"]]]],
      },
      {
        method: "isNaN",
        params: [["Number", ["undefined", null]]],
        returns: "Boolean",
        native: true,
        meta: [["native", [["", "Toplevel::isNaN"]]]],
      },
      {
        method: "isFinite",
        params: [["Number", ["undefined", null]]],
        returns: "Boolean",
        native: true,
        meta: [["native", [["", "Toplevel::isFinite"]]]],
      },
      {
        method: "parseInt",
        params: [
          ["String", ["string", "NaN"]],
          ["int", ["int", 0]],
        ],
        returns: "Number",
        native: true,
        meta: [["native", [["", "Toplevel::parseInt"]]]],
      },
      {
        method: "parseFloat",
        params: [["String", ["string", "NaN"]]],
        returns: "Number",
        native: true,
        meta: [["native", [["", "Toplevel::parseFloat"]]]],
      },
      {
        method: "escape",
        params: [["String", ["string", "undefined"]]],
        returns: "String",
        native: true,
        meta: [["native", [["", "Toplevel::escape"]]]],
      },
      {
        method: "unescape",
        params: [["String", ["string", "undefined"]]],
        returns: "String",
        native: true,
        meta: [["native", [["", "Toplevel::unescape"]]]],
      },
      {
        method: "isXMLName",
        params: [["*", ["undefined", null]]],
        returns: "Boolean",
        native: true,
        meta: [["native", [["", "Toplevel::isXMLName"]]]],
      },
      { const: "NaN", type: "Number", value: ["double", "NaN"] },
      { const: "Infinity", type: "Number", value: ["double", "Infinity"] },
      { const: "undefined" },
      {
        class: VectorClass,
        meta: [
          [
            "native",
            [
              ["cls", "VectorClass"],
              ["gc", "exact"],
              ["instance", "ObjectVectorObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: Vector$objectClass,
        meta: [
          [
            "native",
            [
              ["cls", "ObjectVectorClass"],
              ["gc", "exact"],
              ["instance", "ObjectVectorObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: Vector$intClass,
        meta: [
          [
            "native",
            [
              ["cls", "IntVectorClass"],
              ["gc", "exact"],
              ["instance", "IntVectorObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: Vector$uintClass,
        meta: [
          [
            "native",
            [
              ["cls", "UIntVectorClass"],
              ["gc", "exact"],
              ["instance", "UIntVectorObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        class: Vector$doubleClass,
        meta: [
          [
            "native",
            [
              ["cls", "DoubleVectorClass"],
              ["gc", "exact"],
              ["instance", "DoubleVectorObject"],
              ["methods", "auto"],
              ["construct", "override"],
            ],
          ],
        ],
      },
      {
        method: "internal:avmplus::describeTypeJSON",
        params: ["*", "uint"],
        returns: "Object",
        native: true,
        meta: [["native", [["", "DescribeTypeClass::describeTypeJSON"]]]],
      },
      { const: "internal:avmplus::extendsXml", type: "XML" },
      { const: "internal:avmplus::implementsXml", type: "XML" },
      { const: "internal:avmplus::constructorXml", type: "XML" },
      { const: "internal:avmplus::constantXml", type: "XML" },
      { const: "internal:avmplus::variableXml", type: "XML" },
      { const: "internal:avmplus::accessorXml", type: "XML" },
      { const: "internal:avmplus::methodXml", type: "XML" },
      { const: "internal:avmplus::parameterXml", type: "XML" },
      { const: "internal:avmplus::metadataXml", type: "XML" },
      { const: "internal:avmplus::argXml", type: "XML" },
      { const: "internal:avmplus::typeXml", type: "XML" },
      { const: "internal:avmplus::factoryXml", type: "XML" },
      {
        method: "internal:avmplus::describeParams",
        params: ["XML", "Object"],
        returns: "void",
        avmplus: true,
      },
      {
        method: "internal:avmplus::describeMetadata",
        params: ["XML", "Array"],
        returns: "void",
        avmplus: true,
      },
      {
        method: "internal:avmplus::finish",
        params: ["XML", "Object"],
        returns: "void",
        avmplus: true,
      },
      {
        method: "internal:avmplus::describeTraits",
        params: ["XML", "Object"],
        returns: "void",
        avmplus: true,
      },
      { const: "avmplus::HIDE_NSURI_METHODS", type: "uint", value: ["int", 1] },
      { const: "avmplus::INCLUDE_BASES", type: "uint", value: ["int", 2] },
      { const: "avmplus::INCLUDE_INTERFACES", type: "uint", value: ["int", 4] },
      { const: "avmplus::INCLUDE_VARIABLES", type: "uint", value: ["int", 8] },
      { const: "avmplus::INCLUDE_ACCESSORS", type: "uint", value: ["int", 16] },
      { const: "avmplus::INCLUDE_METHODS", type: "uint", value: ["int", 32] },
      { const: "avmplus::INCLUDE_METADATA", type: "uint", value: ["int", 64] },
      { const: "avmplus::INCLUDE_CONSTRUCTOR", type: "uint", value: ["int", 128] },
      { const: "avmplus::INCLUDE_TRAITS", type: "uint", value: ["int", 256] },
      { const: "avmplus::USE_ITRAITS", type: "uint", value: ["int", 512] },
      { const: "avmplus::HIDE_OBJECT", type: "uint", value: ["int", 1024] },
      { const: "avmplus::FLASH10_FLAGS", type: "uint" },
      { method: "avmplus::describeType", params: ["*", "uint"], returns: "XML", avmplus: true },
      {
        method: "avmplus::getQualifiedClassName",
        params: ["*"],
        returns: "String",
        native: true,
        meta: [["native", [["", "DescribeTypeClass::getQualifiedClassName"]]]],
      },
      {
        method: "avmplus::getQualifiedSuperclassName",
        params: ["*"],
        returns: "String",
        native: true,
        meta: [["native", [["", "DescribeTypeClass::getQualifiedSuperclassName"]]]],
      },
    ],
  },
];
