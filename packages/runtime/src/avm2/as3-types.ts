// What natives know of an AS3 object's class: the declarations generated
// from a library's ABC (builtin-types.generated.ts here, playerglobal's in
// @swf2es/player) describe each class's public members, and a Ref to one
// stands for an object of that class, whose members Runtime.prop, setProp
// and callProp reach by name as getProperty, setProperty and callProperty
// do. A Ref has no JS properties of its own to read: an AS3 object keeps
// its slots under keys of the runtime's, so `r.x` would not be its x.

declare const as3: unique symbol;

/** An AS3 object of the class whose public members `T` declares (docs/architecture/runtime.md). */
export interface Ref<T> {
  readonly [as3]: T;
}

/** Whether two types are the same, readonly-ness included. */
type Same<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

/** Whether `T` is any, as a property of type * or Object is: a value, never a method. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** The names of `T`'s methods, which callProp calls. */
export type MethodName<T> = {
  [K in keyof T]-?: IsAny<T[K]> extends true
    ? never
    : T[K] extends (...args: never[]) => unknown
      ? K
      : never;
}[keyof T] &
  string;

/** The names of `T`'s properties, which prop reads: its variables, constants and accessors. */
export type PropertyName<T> = Exclude<keyof T & string, MethodName<T>>;

/** The names of the properties of `T` that setProp may write: neither constants nor read-only accessors. */
export type WritableName<T> = {
  // Over keyof T itself, so that `{ [Q in K]: T[K] }` keeps K's readonly.
  [K in keyof T]-?: Same<{ [Q in K]: T[K] }, { -readonly [Q in K]: T[K] }> extends true ? K : never;
}[keyof T] &
  PropertyName<T>;
