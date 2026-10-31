import {
  type Buffer3D,
  type Context3D,
  Context3DError,
  type Program3D,
  type Stage3DHost,
  type Texture3D,
} from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../../scripting/events.js";
import type { Scripting } from "../../scripting.js";

export type AsObject = avm2.AsObject;
export type ResourceValue = Buffer3D | Program3D | Texture3D;

export interface Resource<T> {
  value: T;
  owner: AsObject;
  disposed: boolean;
  reference: WeakRef<AsObject>;
}

export interface TextureResource extends Resource<Texture3D> {
  initialized: boolean;
}

export interface ContextState {
  backend: Context3D;
  slot: AsObject;
  cleared: number;
  depth: boolean;
  aa: number;
  target: TextureResource | null;
  targetObject: AsObject | null;
  /** A compressed texture is the target: AIR takes it, and refuses to clear or draw (#3746). */
  compressedTarget: boolean;
  program: AsObject | null;
  vertices: (AsObject | null)[];
  textures: (AsObject | null)[];
  resources: Set<Resource<ResourceValue>>;
}

/** Error #3708 for what Context3D does not do yet, `what` naming it for the console. */
export function unsupported(what: string): never {
  throw new Context3DError("unsupported", `Context3D does not support ${what} yet`);
}

export function createBindings(s: Scripting, host: Stage3DHost) {
  const slots = new WeakMap<AsObject, AsObject>();
  const pending = new WeakSet<AsObject>();
  const generations = new WeakMap<AsObject, object>();
  const lost = new Map<AsObject, object>();
  const contexts = new Map<AsObject, ContextState>();
  const buffers = new WeakMap<AsObject, Resource<Buffer3D>>();
  const programs = new WeakMap<AsObject, Resource<Program3D>>();
  const textures = new WeakMap<AsObject, TextureResource>();
  const indices = new WeakMap<AsObject, number>();
  let closed = false;

  const release = (entry: Resource<ResourceValue>): void => {
    contexts.get(entry.owner)?.resources.delete(entry);
    finalized.unregister(entry);
    entry.value.dispose();
    entry.disposed = true;
  };
  // Held records never strongly reference their own AS wrapper. Active bindings
  // keep wrappers alive through ContextState until they are replaced or cleared.
  const finalized = new FinalizationRegistry<Resource<ResourceValue>>((entry) => {
    if (contexts.get(entry.owner)?.resources.has(entry)) {
      release(entry);
    }
  });
  const own = <T extends Resource<ResourceValue>>(object: AsObject, entry: T): T => {
    contexts.get(entry.owner)?.resources.add(entry);
    finalized.register(object, entry, entry);
    return entry;
  };
  const allocate = <T>(owner: AsObject, create: () => T): T => {
    try {
      return create();
    } catch (error) {
      // A full collection can precede its finalizers. Recover that capacity
      // before refusing an allocation, without scanning warm draw paths.
      let collected = false;
      const resources = contexts.get(owner)?.resources;
      if (resources) {
        for (const entry of resources) {
          if (!entry.reference.deref()) {
            release(entry);
            collected = true;
          }
        }
      }
      if (!collected) {
        throw error;
      }

      return create();
    }
  };
  const closeContext = (entry: ContextState): void => {
    for (const resource of entry.resources) {
      finalized.unregister(resource);
    }
    entry.resources.clear();
    entry.vertices.fill(null);
    entry.textures.fill(null);
    entry.program = null;
    entry.target = null;
    entry.targetObject = null;
    entry.backend.dispose();
  };
  const disposeResource = (object: AsObject, entry: Resource<ResourceValue> | undefined): void => {
    if (!entry || entry.disposed) {
      return;
    }

    release(entry);
    const owner = contexts.get(entry.owner);
    if (!owner) {
      return;
    }

    for (let i = 0; i < 8; i++) {
      if (owner.vertices[i] === object) {
        owner.vertices[i] = null;
      }
      if (owner.textures[i] === object) {
        owner.textures[i] = null;
      }
    }
    if (owner.program === object) {
      owner.program = null;
    }
    if (owner.targetObject === object) {
      owner.target = null;
      owner.targetObject = null;
    }
  };

  const indexOf = (slot: AsObject): number => {
    let index = indices.get(slot);
    if (index === undefined) {
      const vector = s.rt.getProperty(s.stage?.object, s.rt.publicName("stage3Ds")) as AsObject;
      index = (vector.$a as AsObject[]).indexOf(slot);
      if (index < 0) {
        unsupported("a Stage3D that the stage does not list");
      }

      indices.set(slot, index);
    }

    return index;
  };
  const place = (slot: AsObject): void => {
    if (!closed && slots.has(slot)) {
      host.place(indexOf(slot), slot.$x ?? 0, slot.$y ?? 0, slot.$visible ?? true);
    }
  };

  const state = (o: AsObject): ContextState => {
    const entry = contexts.get(o);
    if (!entry || entry.backend.disposed) {
      throw s.rt.error("Error", 3694);
    }

    return entry;
  };
  const context = (o: AsObject): Context3D => state(o).backend;
  const requireClear = (entry: ContextState): void => {
    if (!entry.backend.width || !entry.backend.height) {
      throw s.rt.error("Error", 3698);
    }

    const target = entry.target;
    const required = entry.depth ? 7 : 1;
    if (target ? !target.initialized : (entry.cleared & required) !== required) {
      throw s.rt.error("Error", target ? 3777 : 3692);
    }
  };
  const buffer = (o: AsObject): Buffer3D => {
    const value = buffers.get(o);
    if (!value) {
      throw s.rt.error("Error", 3694);
    }

    if (value.disposed || !contexts.has(value.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return value.value;
  };
  const program = (o: AsObject): Program3D => {
    const value = programs.get(o);
    if (!value) {
      throw s.rt.error("Error", 3694);
    }

    if (value.disposed || !contexts.has(value.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return value.value;
  };
  const construct = (
    name: string,
    resource?: ResourceValue,
    namespace = "flash.display3D",
  ): AsObject => {
    try {
      // Flash reserves these constructors for its native factories.
      const traits = s.rt.classNamed(`${namespace}::${name}`).$it;
      const object = traits.instance();
      const dispatcher = s.rt.classNamed("flash.events::EventDispatcher");
      if (traits.isSubtypeOf(dispatcher.$it)) {
        s.rt.constructSuper(dispatcher, object);
      }

      return object;
    } catch (error) {
      resource?.dispose();
      throw error;
    }
  };
  const texture = (o: AsObject): Texture3D => {
    const entry = textures.get(o);
    if (!entry) {
      throw s.rt.error("Error", 3694);
    }
    if (!contexts.has(entry.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return entry.value;
  };
  const bytes = (o: AsObject): Uint8Array => {
    const storage = avm2.bytesOf(s.rt, o);
    return storage.buffer.subarray(0, storage.length);
  };

  const deferEvent = (deliver: () => void): void => {
    // A constructor's request must leave the current script turn, including
    // its first-frame scripts, before the frame queue can deliver the result.
    queueMicrotask(() => s.loads.deferHostEvent(deliver));
  };
  const created = (slot: AsObject): void => {
    dispatchEvent(
      s,
      slot,
      s.rt.construct(s.rt.classNamed("flash.events::Event"), "context3DCreate") as AsObject,
    );
  };
  const unavailable = (slot: AsObject): void => {
    deferEvent(() => {
      if (!closed && !s.destroyed) {
        dispatchEvent(
          s,
          slot,
          s.rt.construct(
            s.rt.classNamed("flash.events::ErrorEvent"),
            "error",
            false,
            false,
            "Error #3702: Context3D not available.",
            3702,
          ) as AsObject,
        );
      }
    });
  };
  const request = (slot: AsObject): void => {
    if (pending.has(slot) || lost.has(slot)) {
      return;
    }

    pending.add(slot);
    deferEvent(() => {
      pending.delete(slot);
      if (closed || s.destroyed || lost.has(slot)) {
        return;
      }
      const previous = slots.get(slot);
      if (previous) {
        dispose(previous);
      }

      const generation = {};
      generations.set(slot, generation);
      const index = indexOf(slot);
      let backend: Context3D;
      try {
        backend = host.create(index, {
          lost: () => {
            if (closed || s.destroyed || generations.get(slot) !== generation || lost.has(slot)) {
              return;
            }

            const object = slots.get(slot);
            if (!object) {
              return;
            }

            const entry = contexts.get(object);
            contexts.delete(object);
            slots.delete(slot);
            lost.set(slot, generation);
            if (entry) {
              closeContext(entry);
            }
          },
          restored: () => {
            if (closed || s.destroyed || lost.get(slot) !== generation) {
              return;
            }

            lost.delete(slot);
            generations.delete(slot);
            host.remove(index);
            request(slot);
          },
        });
      } catch (error) {
        generations.delete(slot);
        if (error instanceof Context3DError) {
          host.remove(index);
          unavailable(slot);
          return;
        }

        throw error;
      }
      // Older content reads a compressed texture with any sampler, as AIR lets it.
      backend.samplerFormats = s.rt.swfVersion >= 17;
      let object: AsObject;
      try {
        object = construct("Context3D");
      } catch (error) {
        generations.delete(slot);
        backend.dispose();
        host.remove(index);
        throw error;
      }

      contexts.set(object, {
        backend,
        slot,
        cleared: 0,
        depth: false,
        aa: 0,
        target: null,
        targetObject: null,
        compressedTarget: false,
        program: null,
        vertices: new Array(8).fill(null),
        textures: new Array(8).fill(null),
        resources: new Set(),
      });
      slots.set(slot, object);
      place(slot);
      created(slot);
    });
  };

  const dispose = (object: AsObject): AsObject | null => {
    const entry = contexts.get(object);
    if (!entry) {
      return null;
    }

    contexts.delete(object);
    slots.delete(entry.slot);
    generations.delete(entry.slot);
    closeContext(entry);
    host.remove(indexOf(entry.slot));
    return entry.slot;
  };

  const close = () => {
    closed = true;
    for (const object of contexts.keys()) {
      dispose(object);
    }
    for (const slot of lost.keys()) {
      generations.delete(slot);
      host.remove(indexOf(slot));
    }
    lost.clear();
  };

  return {
    slots,
    pending,
    lost,
    contexts,
    buffers,
    programs,
    textures,
    own,
    allocate,
    disposeResource,
    place,
    state,
    context,
    requireClear,
    buffer,
    program,
    construct,
    texture,
    bytes,
    request,
    unavailable,
    dispose,
    close,
    get closed() {
      return closed;
    },
  } as const;
}

export type Bindings = ReturnType<typeof createBindings>;
