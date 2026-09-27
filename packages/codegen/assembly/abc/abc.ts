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
  /** The owner (see instanceOwner, classOwner, scriptOwner) a method is bound to, or -1. */
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

  // traits_info of every instance, class and script, in that order.
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

  /** Record the first error, as avmplus stops at the first throw; returns false. */
  fail(error: i32): bool {
    if (!this.error) {
      this.error = error;
    }

    return false;
  }
}
