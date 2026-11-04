// biome-ignore-all lint/suspicious/noPrototypeBuiltins: Calls model the AS3-shaped API.
// Independent behavioral prototype. No swf2es runtime or compiler imports.
// Lookup uses Map/WeakMap; enumeration uses a shared, mutable slot table.

const identities = new WeakMap();
let identity = 0;
const DONE = Object.freeze({ value: undefined, done: true });

function objectKey(key) {
  return key !== null && (typeof key === "object" || typeof key === "function");
}

function propertyName(key) {
  if (typeof key === "symbol" || typeof key === "bigint") {
    throw new TypeError("Symbols and BigInts are outside the ActionScript key domain");
  }

  return String(key);
}

function hashObject(key) {
  let hash = identities.get(key);
  if (hash === undefined) {
    const n = Math.imul(++identity, 0x9e3779b1);
    // Even home slots leave a following collision slot for a reinsertion.
    hash = (n ^ (n >>> 16)) & 0xfffffffe;
    identities.set(key, hash);
  }

  return hash >>> 0;
}

function hashString(name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  }

  return hash >>> 0;
}

function enumeratedName(name) {
  const n = Number(name);
  return n >= 0 && n < 0x10000000 && Number.isInteger(n) && String(n) === name ? n : name;
}

export class Avm2Dictionary {
  static prototypeProperties = Object.assign(Object.create(null), {
    toString() {
      return "[object Dictionary]";
    },
    valueOf() {
      return this;
    },
    hasOwnProperty(key) {
      return this.hasOwnProperty(key);
    },
    propertyIsEnumerable(key) {
      return this.propertyIsEnumerable(key);
    },
  });

  #weak;
  #objects;
  #weakRecords;
  #named = new Map();
  #slots = new Array(16).fill(null);
  #size = 0;
  #used = 0;
  #deleted = 0;
  #revision = 0;
  #prototype;

  constructor(weakKeys = false, prototypeProperties = Avm2Dictionary.prototypeProperties) {
    this.#weak = Boolean(weakKeys);
    this.#objects = this.#weak ? new WeakMap() : new Map();
    this.#weakRecords = this.#weak ? new WeakMap() : null;
    this.#prototype = prototypeProperties;
  }

  get weakKeys() {
    return this.#weak;
  }
  get revision() {
    return this.#revision;
  }
  get size() {
    this.#sweep();
    return this.#size;
  }

  get(key) {
    if (objectKey(key)) {
      return this.#objects.get(key)?.value;
    }

    const name = propertyName(key);
    const entry = this.#named.get(name);
    return entry === undefined ? this.#prototype[name] : entry.value;
  }

  containsKey(key) {
    return objectKey(key) ? this.#objects.has(key) : this.#named.has(propertyName(key));
  }

  // The AS3 `in` operation: an absent object key is coerced for the prototype only.
  has(key) {
    if (objectKey(key)) {
      return this.#objects.has(key) || propertyName(key) in this.#prototype;
    }

    const name = propertyName(key);
    return this.#named.has(name) || name in this.#prototype;
  }

  set(key, value) {
    const object = objectKey(key);
    const weak = object && this.#weak;
    const name = object ? key : propertyName(key);
    const store = object ? this.#objects : this.#named;
    const stored = store.get(name);
    if (stored !== undefined) {
      stored.value = value;

      return this;
    }

    this.#room();
    const entry = {
      hash: object ? hashObject(key) : hashString(name),
      key: name,
      value: weak ? undefined : value,
      kind: weak ? 2 : object ? 1 : 0,
      live: true,
    };
    if (weak) {
      // The ephemeron owns the record; enumeration holds only a weak reference to it.
      // The record may point back to its key without making that key a root.
      let record = this.#weakRecords.get(key);
      if (record === undefined) {
        record = { key, value, entry, reference: null };
        record.reference = new WeakRef(record);
        this.#weakRecords.set(key, record);
      } else {
        record.key = key;
        record.value = value;
        record.entry = entry;
      }

      entry.key = record.reference;
      store.set(name, record);
    } else {
      store.set(name, entry);
    }

    this.#insert(entry);
    this.#size++;
    this.#revision++;
    return this;
  }

  delete(key) {
    const object = objectKey(key);
    const name = object ? key : propertyName(key);
    const store = object ? this.#objects : this.#named;
    const entry = store.get(name);
    if (entry !== undefined) {
      store.delete(name);
      if (object && this.#weak) {
        this.#retire(entry.entry);
        // Keep reusable metadata in the ephemeron, with no deleted key/value references.
        entry.key = undefined;
        entry.value = undefined;
        entry.entry = null;
      } else {
        this.#retire(entry);
      }
    }

    return true;
  }

  hasOwnProperty(key) {
    return this.#named.has(propertyName(key));
  }

  propertyIsEnumerable(key) {
    return this.#named.has(propertyName(key));
  }

  setPropertyIsEnumerable(key, _enumerable) {
    // Adobe coerces the argument but ignores visibility changes on Dictionaries.
    propertyName(key);
  }

  // Host storage API: compact at an idle boundary, since physical cursor indices change.
  trim() {
    this.#sweep();
    if (this.#weak) {
      const records = new WeakMap();
      for (const entry of this.#slots) {
        if (entry?.live && entry.kind === 2) {
          const record = entry.key.deref();
          if (record !== undefined) {
            records.set(record.key, record);
          }
        }
      }

      this.#weakRecords = records;
    }

    let capacity = 16;
    while ((this.#size + 1) * 4 >= capacity * 3) {
      capacity *= 2;
    }

    this.#rebuild(capacity);
    this.#revision++;
    return this;
  }

  // Indices refer to physical slots shared by every walk, rather than JS iterator positions.
  nextNameIndex(index) {
    if (index === 0) {
      this.#prepare();
    }

    for (let i = index; i < this.#slots.length; i++) {
      const entry = this.#slots[i];
      // biome-ignore lint/complexity/useOptionalChain: Keep the measured cursor fast path.
      if (entry !== null && entry.live) {
        if (entry.kind === 2 && entry.key.deref() === undefined) {
          this.#retire(entry);
        } else {
          return i + 1;
        }
      }
    }

    return 0;
  }

  nextName(index) {
    const entry = this.#slots[index - 1];
    if (!entry?.live) {
      return undefined;
    }

    switch (entry.kind) {
      case 0:
        return enumeratedName(entry.key);
      case 2:
        return entry.key.deref()?.key;
      default:
        return entry.key;
    }
  }

  nextValue(index) {
    const entry = this.#slots[index - 1];
    if (!entry?.live) {
      return undefined;
    }

    return entry.kind === 2 ? entry.key.deref()?.value : entry.value;
  }

  keys() {
    return this.#iterator(0);
  }
  values() {
    return this.#iterator(1);
  }
  entries() {
    return this.#iterator(2);
  }
  [Symbol.iterator]() {
    return this.entries();
  }

  #iterator(mode) {
    let owner = this;
    let index = 0;
    let started = false;
    return {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        if (owner === null) {
          return DONE;
        }

        if (!started) {
          owner.#prepare();
          started = true;
        }

        // Nothing returned to the caller is retained in this iterator's closure.
        while (index < owner.#slots.length) {
          const entry = owner.#slots[index++];
          if (entry === null || !entry.live) {
            continue;
          }

          const record = entry.kind === 2 ? entry.key.deref() : entry;
          if (record === undefined) {
            owner.#retire(entry);
            continue;
          }

          const key = record.key;
          switch (mode) {
            case 0:
              return { value: entry.kind === 0 ? enumeratedName(key) : key, done: false };
            case 1:
              return { value: record.value, done: false };
            default:
              return {
                value: [entry.kind === 0 ? enumeratedName(key) : key, record.value],
                done: false,
              };
          }
        }

        owner = null;
        return DONE;
      },
      return() {
        owner = null;
        return DONE;
      },
    };
  }

  #retire(entry) {
    if (!entry.live) {
      return;
    }

    entry.live = false;
    entry.key = undefined;
    entry.value = undefined;
    this.#size--;
    this.#deleted++;
    this.#revision++;
  }

  #sweep() {
    if (!this.#weak) {
      return;
    }

    for (const entry of this.#slots) {
      if (entry?.live && entry.kind === 2 && entry.key.deref() === undefined) {
        this.#retire(entry);
      }
    }
  }

  #prepare() {
    if (this.#deleted !== 0) {
      this.#sweep();
      this.#rebuild(this.#slots.length);
    }
  }

  #room() {
    if ((this.#used + 1) * 4 < this.#slots.length * 3) {
      return;
    }

    this.#sweep();
    this.#rebuild(
      (this.#size + 1) * 4 < this.#slots.length * 3 ? this.#slots.length : this.#slots.length * 2,
    );
  }

  #insert(entry) {
    const mask = this.#slots.length - 1;
    let slot = entry.hash & mask;
    // Deleted slots remain occupied until compaction, permitting a live walk to see reinsertion.
    while (this.#slots[slot] !== null) {
      slot = (slot + 1) & mask;
    }

    this.#slots[slot] = entry;
    this.#used++;
  }

  #rebuild(capacity) {
    const previous = this.#slots;
    this.#slots = new Array(capacity).fill(null);
    this.#used = 0;
    this.#deleted = 0;
    for (const entry of previous) {
      if (entry?.live) {
        this.#insert(entry);
      }
    }
  }
}
