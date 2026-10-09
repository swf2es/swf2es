// Error and its subclasses, the builtin's and flash.errors': their natives,
// held to their declarations, and their class hooks. One file for the
// family, as Error.as is: each subclass's constructor is Error's and its
// name, nothing else.

import type { AsObject, Value } from "../descriptors.js";
import type { ClassHook } from "../hooks.js";
import { errorMessages } from "../player-messages.js";
import type { Runtime } from "../runtime.js";
import { slotKey } from "../traits.js";
import { ArgumentErrorDecl } from "./ArgumentError.decl.js";
import { type BuiltinClass, bindNatives } from "./bind.js";
import { DefinitionErrorDecl } from "./DefinitionError.decl.js";
import { ErrorDecl } from "./Error.decl.js";
import { EvalErrorDecl } from "./EvalError.decl.js";
import { EOFErrorDecl } from "./flash/errors/EOFError.decl.js";
import { IllegalOperationErrorDecl } from "./flash/errors/IllegalOperationError.decl.js";
import { IOErrorDecl } from "./flash/errors/IOError.decl.js";
import { MemoryErrorDecl } from "./flash/errors/MemoryError.decl.js";
import { RangeErrorDecl } from "./RangeError.decl.js";
import { ReferenceErrorDecl } from "./ReferenceError.decl.js";
import { SecurityErrorDecl } from "./SecurityError.decl.js";
import { SyntaxErrorDecl } from "./SyntaxError.decl.js";
import { TypeErrorDecl } from "./TypeError.decl.js";
import { UninitializedErrorDecl } from "./UninitializedError.decl.js";
import { URIErrorDecl } from "./URIError.decl.js";
import { VerifyErrorDecl } from "./VerifyError.decl.js";

/**
 * The property of Error's private _errorID slot, by its name: the
 * namespace is builtin's own private one, which no name made here is.
 */
function errorIDKey(rt: Runtime): string {
  const binding = rt.builtinClass("Error").$it.bindings.get("_errorID")[0].value;
  return slotKey(binding >> 3);
}

/**
 * Error.getErrorMessage's text: in debugger mode the template, %1 and all,
 * as the debugger player has it; else, or for an id it has no text for,
 * the number alone.
 */
function errorMessage(rt: Runtime, id: number): string {
  return rt.debugger && errorMessages[id] ? `Error #${id}: ${errorMessages[id]}` : `Error #${id}`;
}

/** `o`'s name, as `this.name = prototype.name` in the constructor of `cls` sets it. */
function nameFrom(rt: Runtime, o: AsObject, cls: AsObject): void {
  const name = rt.publicName("name");
  rt.setProperty(o, name, rt.getProperty(cls.$prototype, name));
}

/**
 * A subclass's constructor, as its AS3 is: Error's, then, but for
 * flash.errors' classes, `this.name = prototype.name` with its own
 * prototype, of the class named `own`.
 */
function construct(rt: Runtime, o: AsObject, message: Value, id: Value, own: string | null): void {
  rt.constructSuper(rt.builtinClass("Error"), o, message, id);
  if (own) {
    nameFrom(rt, o, rt.builtinClass(own));
  }
}

/**
 * The native error classes, which construct an error when called, as
 * ErrorClass::call does: Error("x") is new Error("x"), not a coercion.
 * flash.errors' are AS3 classes, and coerce.
 */
const constructs: ClassHook = { call: (rt, cls, args) => rt.constructClass(cls, args) };

/**
 * An AS3 error's JavaScript error, made with it: where it was made, the
 * compiled method's name in it, for a host to show (Runtime.stackOf). The
 * release player has no stack trace for AS3 to read, and getStackTrace
 * still gives null.
 */
const errorClass: ClassHook = {
  ...constructs,
  create: (traits) => {
    const o = Object.create(traits.proto);
    // V8 keeps 10 frames, and the runtime's own take most of those before the first AS3 one.
    const engine = Error as ErrorConstructor & { stackTraceLimit?: number };
    const limit = engine.stackTraceLimit;
    engine.stackTraceLimit = 48;
    Object.defineProperty(o, "$jsError", { value: new Error() });
    engine.stackTraceLimit = limit;
    return o;
  },
};

/** Error and its subclasses, builtin's and flash.errors'. */
export const ErrorBuiltins: BuiltinClass[] = [
  bindNatives(
    ErrorDecl,
    (rt) => {
      let errorID: string | null = null;
      return class ErrorNatives {
        Error(this: AsObject, message: Value, id: Value) {
          errorID ??= errorIDKey(rt);
          rt.setProperty(this, rt.publicName("message"), message);
          this[errorID] = rt.toInt(id);
          nameFrom(rt, this, rt.builtinClass("Error"));
        }

        static getErrorMessage(id: number) {
          return errorMessage(rt, id);
        }

        // Its message's %1 to %6 the arguments after the id, or nothing where
        // there are fewer, and the rest of %0 to %9 nothing.
        static throwError(type: Value, index: number, ...args: Value[]) {
          const message = errorMessage(rt, index).replace(/%[0-9]/g, (m) => {
            const n = "123456".indexOf(m[1]);
            return n >= 0 && n < args.length ? rt.toString(args[n]) : "";
          });
          throw rt.construct(type, message, index);
        }

        getStackTrace() {
          return null;
        }

        get errorID(): number {
          errorID ??= errorIDKey(rt);
          return (this as AsObject)[errorID];
        }
      };
    },
    errorClass,
  ),
  bindNatives(
    DefinitionErrorDecl,
    (rt) =>
      class DefinitionErrorNatives {
        DefinitionError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "DefinitionError");
        }
      },
    constructs,
  ),
  bindNatives(
    EvalErrorDecl,
    (rt) =>
      class EvalErrorNatives {
        EvalError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "EvalError");
        }
      },
    constructs,
  ),
  bindNatives(
    RangeErrorDecl,
    (rt) =>
      class RangeErrorNatives {
        RangeError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "RangeError");
        }
      },
    constructs,
  ),
  bindNatives(
    ReferenceErrorDecl,
    (rt) =>
      class ReferenceErrorNatives {
        ReferenceError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "ReferenceError");
        }
      },
    constructs,
  ),
  bindNatives(
    SecurityErrorDecl,
    (rt) =>
      class SecurityErrorNatives {
        SecurityError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "SecurityError");
        }
      },
    constructs,
  ),
  bindNatives(
    SyntaxErrorDecl,
    (rt) =>
      class SyntaxErrorNatives {
        SyntaxError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "SyntaxError");
        }
      },
    constructs,
  ),
  bindNatives(
    TypeErrorDecl,
    (rt) =>
      class TypeErrorNatives {
        TypeError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "TypeError");
        }
      },
    constructs,
  ),
  bindNatives(
    URIErrorDecl,
    (rt) =>
      class URIErrorNatives {
        URIError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "URIError");
        }
      },
    constructs,
  ),
  bindNatives(
    VerifyErrorDecl,
    (rt) =>
      class VerifyErrorNatives {
        VerifyError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "VerifyError");
        }
      },
    constructs,
  ),
  bindNatives(
    UninitializedErrorDecl,
    (rt) =>
      class UninitializedErrorNatives {
        UninitializedError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "UninitializedError");
        }
      },
    constructs,
  ),
  bindNatives(
    ArgumentErrorDecl,
    (rt) =>
      class ArgumentErrorNatives {
        ArgumentError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, "ArgumentError");
        }
      },
    constructs,
  ),
  bindNatives(
    IOErrorDecl,
    (rt) =>
      class IOErrorNatives {
        IOError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, null);
        }
      },
  ),
  bindNatives(
    EOFErrorDecl,
    (rt) =>
      class EOFErrorNatives {
        EOFError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, null);
        }
      },
  ),
  bindNatives(
    MemoryErrorDecl,
    (rt) =>
      class MemoryErrorNatives {
        MemoryError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, null);
        }
      },
  ),
  bindNatives(
    IllegalOperationErrorDecl,
    (rt) =>
      class IllegalOperationErrorNatives {
        IllegalOperationError(this: AsObject, message: Value, id: Value) {
          construct(rt, this, message, id, null);
        }
      },
  ),
];
