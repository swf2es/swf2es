// A parsed ABC block (AVM2 overview 4.2) as flat tables indexed like the
// ABC's own arrays. Variable-length parts live in shared arrays: entry i of a
// table owns items [start[i], start[i + 1]).
import { ConstantPool } from "./pool";

@final
export class Abc {
  /** 0, or the VerifyError number avmplus would throw; then the tables are incomplete. */
  error: i32 = 0;
  minorVersion: u32 = 0;
  majorVersion: u32 = 0;
  pool: ConstantPool = new ConstantPool();

  // method_info. Type indices are checked when a method is compiled, as
  // avmplus checks them when a method is first resolved.
  methodReturnType: StaticArray<u32> = new StaticArray<u32>(0);
  /** String index of the method's debug name; not checked by avmplus. */
  methodName: StaticArray<u32> = new StaticArray<u32>(0);
  methodFlags: StaticArray<u8> = new StaticArray<u8>(0);
  methodParamStart: StaticArray<u32> = new StaticArray<u32>(1);
  paramTypes: Array<u32> = [] as u32[];
  methodOptionalStart: StaticArray<u32> = new StaticArray<u32>(1);
  optionalValue: Array<u32> = [] as u32[];
  optionalKind: Array<u8> = [] as u8[];
  /** The owner (see instanceOwner .. activationOwner) a method is bound to, or -1. */
  methodOwner: StaticArray<i32> = new StaticArray<i32>(0);

  // metadata_info
  metadataName: StaticArray<u32> = new StaticArray<u32>(0);
  metadataItemStart: StaticArray<u32> = new StaticArray<u32>(1);
  metadataKey: Array<u32> = [] as u32[];
  metadataValue: Array<u32> = [] as u32[];

  // instance_info and class_info. Base classes and interfaces are checked
  // when classes are linked, since they may come from another ABC.
  instanceName: StaticArray<u32> = new StaticArray<u32>(0);
  /** Multiname of the base class; 0 if there is none. */
  instanceSuper: StaticArray<u32> = new StaticArray<u32>(0);
  instanceFlags: StaticArray<u8> = new StaticArray<u8>(0);
  /** Namespace index; 0 if the class has no protected namespace. */
  instanceProtectedNs: StaticArray<u32> = new StaticArray<u32>(0);
  instanceInterfaceStart: StaticArray<u32> = new StaticArray<u32>(1);
  interfaces: Array<u32> = [] as u32[];
  instanceInit: StaticArray<u32> = new StaticArray<u32>(0);
  classInit: StaticArray<u32> = new StaticArray<u32>(0);

  // script_info
  scriptInit: StaticArray<u32> = new StaticArray<u32>(0);

  // method_body_info, in ABC order.
  /** Index of each method's body, or -1 if it has none. */
  methodBody: StaticArray<i32> = new StaticArray<i32>(0);
  bodyMethod: Array<u32> = [] as u32[];
  bodyMaxStack: Array<u32> = [] as u32[];
  bodyLocalCount: Array<u32> = [] as u32[];
  bodyInitScopeDepth: Array<u32> = [] as u32[];
  bodyMaxScopeDepth: Array<u32> = [] as u32[];
  /** Offset of the bytecode from the start of the ABC. */
  bodyCodeStart: Array<u32> = [] as u32[];
  bodyCodeLength: Array<u32> = [] as u32[];
  bodyExceptionStart: Array<u32> = [] as u32[];
  exceptionFrom: Array<u32> = [] as u32[];
  exceptionTo: Array<u32> = [] as u32[];
  exceptionTarget: Array<u32> = [] as u32[];
  /** Multiname of the caught type; 0 catches everything. */
  exceptionType: Array<u32> = [] as u32[];
  /** Multiname of the catch variable; 0 if it has none. */
  exceptionName: Array<u32> = [] as u32[];
  /** Body b's activation traits are traits [start[b] .. start[b + 1]]. */
  bodyTraitStart: Array<u32> = [] as u32[];

  // traits_info of every instance, class, script and method activation, in that order.
  traitName: Array<u32> = [] as u32[];
  /** Kind in the low 4 bits, attributes in the high 4. */
  traitTag: Array<u8> = [] as u8[];
  /** Slot id, or disp id for methods. */
  traitId: Array<u32> = [] as u32[];
  /** Type multiname (slots), class index or method index. */
  traitIndex: Array<u32> = [] as u32[];
  /** Constant pool index of a slot's default value; 0 if none. */
  traitValue: Array<u32> = [] as u32[];
  traitValueKind: Array<u8> = [] as u8[];
  traitMetadataStart: Array<u32> = [] as u32[];
  traitMetadata: Array<u32> = [] as u32[];
  instanceTraitStart: StaticArray<u32> = new StaticArray<u32>(1);
  classTraitStart: StaticArray<u32> = new StaticArray<u32>(1);
  scriptTraitStart: StaticArray<u32> = new StaticArray<u32>(1);

  @inline
  get methodCount(): u32 {
    return this.methodFlags.length;
  }

  @inline
  get metadataCount(): u32 {
    return this.metadataName.length;
  }

  @inline
  get classCount(): u32 {
    return this.instanceName.length;
  }

  @inline
  get scriptCount(): u32 {
    return this.scriptInit.length;
  }

  @inline
  instanceOwner(i: u32): i32 {
    return <i32>i;
  }

  @inline
  classOwner(i: u32): i32 {
    return <i32>(this.classCount + i);
  }

  @inline
  scriptOwner(i: u32): i32 {
    return <i32>(2 * this.classCount + i);
  }

  /** The owner of method m's activation traits. */
  @inline
  activationOwner(m: u32): i32 {
    return <i32>(2 * this.classCount + this.scriptCount + m);
  }

  @inline
  get bodyCount(): u32 {
    return this.bodyMethod.length;
  }

  /** Record the first error, as avmplus stops at the first throw; returns false. */
  fail(error: i32): bool {
    if (!this.error) {
      this.error = error;
    }

    return false;
  }
}
