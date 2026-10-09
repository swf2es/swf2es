// builtin's scripts in the order they load, each with the definitions it
// makes (see declare.ts).

import { VectorDecl } from "./__AS3__/vec/Vector.decl.js";
import { Vector$doubleDecl } from "./__AS3__/vec/Vector$double.decl.js";
import { Vector$intDecl } from "./__AS3__/vec/Vector$int.decl.js";
import { Vector$objectDecl } from "./__AS3__/vec/Vector$object.decl.js";
import { Vector$uintDecl } from "./__AS3__/vec/Vector$uint.decl.js";
import { ArgumentErrorDecl } from "./ArgumentError.decl.js";
import { ArrayDecl } from "./Array.decl.js";
import { BooleanDecl } from "./Boolean.decl.js";
import { ClassClassDecl } from "./Class.decl.js";
import { DateDecl } from "./Date.decl.js";
import { DefinitionErrorDecl } from "./DefinitionError.decl.js";
import type { ScriptDecl } from "./declare.js";
import { ErrorDecl } from "./Error.decl.js";
import { EvalErrorDecl } from "./EvalError.decl.js";
import { FunctionDecl } from "./Function.decl.js";
import { ConditionDecl } from "./flash/concurrent/Condition.decl.js";
import { MutexDecl } from "./flash/concurrent/Mutex.decl.js";
import { EOFErrorDecl } from "./flash/errors/EOFError.decl.js";
import { IllegalOperationErrorDecl } from "./flash/errors/IllegalOperationError.decl.js";
import { IOErrorDecl } from "./flash/errors/IOError.decl.js";
import { MemoryErrorDecl } from "./flash/errors/MemoryError.decl.js";
import { DynamicPropertyOutputDecl } from "./flash/net/DynamicPropertyOutput.decl.js";
import { IDynamicPropertyOutputDecl } from "./flash/net/IDynamicPropertyOutput.decl.js";
import { IDynamicPropertyWriterDecl } from "./flash/net/IDynamicPropertyWriter.decl.js";
import { ObjectEncodingDecl } from "./flash/net/ObjectEncoding.decl.js";
import { ByteArrayDecl } from "./flash/utils/ByteArray.decl.js";
import { CompressionAlgorithmDecl } from "./flash/utils/CompressionAlgorithm.decl.js";
import { DictionaryDecl } from "./flash/utils/Dictionary.decl.js";
import { IDataInputDecl } from "./flash/utils/IDataInput.decl.js";
import { IDataInput2Decl } from "./flash/utils/IDataInput2.decl.js";
import { IDataOutputDecl } from "./flash/utils/IDataOutput.decl.js";
import { IDataOutput2Decl } from "./flash/utils/IDataOutput2.decl.js";
import { IExternalizableDecl } from "./flash/utils/IExternalizable.decl.js";
import { ObjectInputDecl } from "./flash/utils/ObjectInput.decl.js";
import { ObjectOutputDecl } from "./flash/utils/ObjectOutput.decl.js";
import { ProxyDecl } from "./flash/utils/Proxy.decl.js";
import { intDecl } from "./int.decl.js";
import { JSONDecl } from "./JSON.decl.js";
import { MathDecl } from "./Math.decl.js";
import { MethodClosureDecl } from "./MethodClosure.decl.js";
import { NamespaceDecl } from "./Namespace.decl.js";
import { NumberDecl } from "./Number.decl.js";
import { ObjectDecl } from "./Object.decl.js";
import { QNameDecl } from "./QName.decl.js";
import { RangeErrorDecl } from "./RangeError.decl.js";
import { ReferenceErrorDecl } from "./ReferenceError.decl.js";
import { RegExpDecl } from "./RegExp.decl.js";
import { SecurityErrorDecl } from "./SecurityError.decl.js";
import { StringDecl } from "./String.decl.js";
import { SyntaxErrorDecl } from "./SyntaxError.decl.js";
import { TypeErrorDecl } from "./TypeError.decl.js";
import { UninitializedErrorDecl } from "./UninitializedError.decl.js";
import { URIErrorDecl } from "./URIError.decl.js";
import { uintDecl } from "./uint.decl.js";
import { VerifyErrorDecl } from "./VerifyError.decl.js";
import { WalkerDecl } from "./Walker.decl.js";
import { XMLDecl } from "./XML.decl.js";
import { XMLListDecl } from "./XMLList.decl.js";

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
        class: MathDecl,
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
        class: ErrorDecl,
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
        class: DefinitionErrorDecl,
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
        class: EvalErrorDecl,
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
        class: RangeErrorDecl,
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
        class: ReferenceErrorDecl,
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
        class: SecurityErrorDecl,
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
        class: SyntaxErrorDecl,
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
        class: TypeErrorDecl,
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
        class: URIErrorDecl,
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
        class: VerifyErrorDecl,
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
        class: UninitializedErrorDecl,
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
        class: ArgumentErrorDecl,
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
      { class: IOErrorDecl },
      { class: EOFErrorDecl },
      { class: MemoryErrorDecl },
      { class: IllegalOperationErrorDecl },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: DateDecl,
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
        class: RegExpDecl,
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
        class: JSONDecl,
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
      { class: WalkerDecl },
    ],
  },
  {
    init: { avmplus: true },
    traits: [
      {
        class: XMLDecl,
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
        class: XMLListDecl,
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
        class: QNameDecl,
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
  { init: { avmplus: true }, traits: [{ class: IDataInputDecl }] },
  { init: { avmplus: true }, traits: [{ class: IDataOutputDecl }] },
  {
    init: { avmplus: true },
    traits: [
      {
        const: "flash.utils::flash_proxy",
        value: ["namespace", "namespace:http://www.adobe.com/2006/actionscript/flash/proxy"],
      },
      {
        class: ProxyDecl,
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
        class: DictionaryDecl,
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
  { init: { avmplus: true }, traits: [{ class: IDynamicPropertyOutputDecl }] },
  { init: { avmplus: true }, traits: [{ class: IDynamicPropertyWriterDecl }] },
  { init: { avmplus: true }, traits: [{ class: IExternalizableDecl }] },
  {
    init: { avmplus: true },
    traits: [
      {
        class: ObjectEncodingDecl,
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
        class: MutexDecl,
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
        class: ConditionDecl,
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
        class: ObjectInputDecl,
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
      { class: CompressionAlgorithmDecl },
      { class: IDataInput2Decl },
      { class: IDataOutput2Decl },
      {
        class: ByteArrayDecl,
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
        class: ObjectOutputDecl,
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
        class: DynamicPropertyOutputDecl,
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
        class: ObjectDecl,
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
        class: ClassClassDecl,
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
        class: FunctionDecl,
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
        class: MethodClosureDecl,
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
        class: NamespaceDecl,
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
        class: BooleanDecl,
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
        class: NumberDecl,
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
        class: intDecl,
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
        class: uintDecl,
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
        class: StringDecl,
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
        class: ArrayDecl,
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
        class: VectorDecl,
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
        class: Vector$objectDecl,
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
        class: Vector$intDecl,
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
        class: Vector$uintDecl,
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
        class: Vector$doubleDecl,
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
