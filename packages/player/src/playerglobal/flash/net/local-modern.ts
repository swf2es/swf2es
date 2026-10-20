// AS3 peers retain AMF3's ByteArray, XML, Vector and alias semantics.
// Reuse the runtime's codec through its public API, with a bounded output
// and scratch buffers leased separately for reentrant serialization.
import { avm2 } from "@swf2es/runtime";
import { MAX_DEPTH } from "../../../avm1/amf.js";
import { LOCAL_MESSAGE_LIMIT } from "../../../localconnection.js";

class MessageBytes extends avm2.Bytes {
  override setLength(length: number, fromSetter = false): void {
    if (length > LOCAL_MESSAGE_LIMIT) {
      throw new RangeError("LocalConnection message too large");
    }

    super.setLength(length, fromSetter);
  }

  override write(source: Uint8Array, offset = 0, count = source.length): void {
    if (count > LOCAL_MESSAGE_LIMIT - this.position) {
      throw new RangeError("LocalConnection message too large");
    }

    super.write(source, offset, count);
  }
}

class MessageWriter extends avm2.Amf3Writer {
  private depth = 0;
  escaped = false;
  private readonly externalizable: avm2.AsObject;

  constructor(
    private readonly runtime: avm2.Runtime,
    bytes: MessageBytes,
  ) {
    super(runtime, bytes);
    this.externalizable = runtime.classNamed("flash.utils::IExternalizable");
  }

  override string(value: string): void {
    if (value.length > LOCAL_MESSAGE_LIMIT - this.bytes.position) {
      throw new RangeError("LocalConnection message too large");
    }

    super.string(value);
  }

  override value(value: avm2.Value): void {
    if (
      value?.$traits?.isSubtypeOf(this.externalizable.$it) ||
      this.runtime.dynamicPropertyWriter
    ) {
      this.escaped = true;
    }

    if (this.depth >= MAX_DEPTH || value?.$bytes?.length > LOCAL_MESSAGE_LIMIT) {
      throw new RangeError("LocalConnection message too large");
    }

    if (value?.$node) {
      const text = this.runtime.callProperty(value, this.runtime.publicName("toXMLString"));
      if (text.length > LOCAL_MESSAGE_LIMIT) {
        throw new RangeError("LocalConnection message too large");
      }
    }

    this.depth++;
    try {
      super.value(value);
    } finally {
      this.depth--;
    }
  }
}

const writers = new WeakMap<avm2.Runtime, MessageBytes[]>();
const readers = new WeakMap<avm2.Runtime, avm2.Bytes[]>();
const empty = new Uint8Array(0);
const emptyView = new DataView(empty.buffer);

class MessageReader extends avm2.Amf3Reader {
  escaped = false;
  private readonly externalizable: avm2.AsObject;

  constructor(rt: avm2.Runtime, bytes: avm2.Bytes) {
    super(rt, bytes);
    this.externalizable = rt.classNamed("flash.utils::IExternalizable");
  }

  override value(): avm2.Value {
    try {
      const value = super.value();
      if (value?.$traits?.isSubtypeOf(this.externalizable.$it)) {
        this.escaped = true;
      }

      return value;
    } catch (error) {
      this.escaped = true;
      throw error;
    }
  }
}

export function writeModernValues(rt: avm2.Runtime, args: avm2.Value[]): Uint8Array<ArrayBuffer> {
  let pool = writers.get(rt);
  if (!pool) {
    pool = [];
    writers.set(rt, pool);
  }

  let bytes = pool.pop();
  if (!bytes) {
    const owner = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    bytes = new MessageBytes(rt, owner);
    owner.$bytes = bytes;
  }

  const writer = new MessageWriter(rt, bytes);
  try {
    writer.value(rt.newArray(args));
    return bytes.buffer.slice(0, bytes.length);
  } finally {
    // An externalizable may retain its ObjectOutput; that stream must stay independent.
    if (!writer.escaped) {
      bytes.position = 0;
      bytes.setLength(0);
      if (pool.length < 2) {
        pool.push(bytes);
      }
    }
  }
}

export function readModernValues(rt: avm2.Runtime, data: Uint8Array<ArrayBuffer>): avm2.Value[] {
  let pool = readers.get(rt);
  if (!pool) {
    pool = [];
    readers.set(rt, pool);
  }

  let bytes = pool.pop();
  if (!bytes) {
    const owner = rt.construct(rt.classNamed("flash.utils::ByteArray"));
    bytes = avm2.bytesOf(rt, owner);
  }

  bytes.buffer = data;
  bytes.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  bytes.length = data.length;
  const reader = new MessageReader(rt, bytes);
  try {
    return reader.value().$a;
  } finally {
    if (!reader.escaped) {
      bytes.buffer = empty;
      bytes.view = emptyView;
      bytes.position = 0;
      bytes.length = 0;
      if (pool.length < 2) {
        pool.push(bytes);
      }
    }
  }
}
