// What a background worker's thread and the thread that started it post to
// each other (docs/workers.md): plain data a structured clone copies, so
// that any host's channel carries it, a Web Worker's or node's
// worker_threads'. The primordial routes every message between workers.
// A shareable ByteArray's memory is SharedArrayBuffers, which a structured
// clone shares rather than copies.
import type { avm2 } from "@swf2es/runtime";

/**
 * A value crossing between workers, as avmplus' ChannelItem makes one: a
 * primitive as itself, a ByteArray as a copy of its bytes, a shareable one
 * as its memory, a MessageChannel by reference, anything else as AMF3.
 */
export type WireValue =
  | { kind: "value"; value: number | boolean | string | null }
  | { kind: "amf"; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "bytes"; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "shared"; memory: avm2.SharedBytesMemory }
  | { kind: "channel"; channel: ChannelRef };

/** A MessageChannel, from its sending worker to its receiving one, by the workers' ids. */
export interface ChannelRef {
  id: number;
  sender: number;
  receiver: number;
}

/** What a thread is given first: the worker's SWF and everything to run it with. */
export interface WorkerInit {
  type: "init";
  /** The worker's id among the primordial's workers; the primordial is 0. */
  id: number;
  /** The bytes WorkerDomain.createWorker was given. */
  swf: Uint8Array<ArrayBuffer>;
  /** The URL its LoaderInfo reports: the primordial's SWF's. */
  url: string;
  /** Security.sandboxType, the primordial's. */
  sandboxType: string;
  /** builtin and playerglobal, as the primordial loaded them. */
  libraries: Uint8Array[];
  /** Its shared properties and the primordial's, as set before it started. */
  shared: SharedMessage[];
}

/** A shared property of worker `worker` set, or deleted where `value` is null. */
export interface SharedMessage {
  type: "shared";
  worker: number;
  /** Its name; null is a key of its own, apart from "null", as in avmplus. */
  key: string | null;
  value: WireValue | null;
}

/** A message sent on `channel`, to be queued at its receiver. */
export interface ChannelMessage {
  type: "message";
  channel: ChannelRef;
  value: WireValue;
}

/** A channel closed at either end. */
export interface ChannelClose {
  type: "close";
  channel: ChannelRef;
  /** Sent by the receiver to the sender once its queue is empty: the channel is closed at both ends. */
  drained: boolean;
}

/** From the primordial to a thread. */
export type ToWorker = WorkerInit | SharedMessage | ChannelMessage | ChannelClose;

/**
 * From a thread to the primordial: its traces, its state, what it set or
 * sent, an error nothing caught, and `idle` after each frame: how many of
 * the messages posted to it, init the first, that frame had delivered, for
 * the primordial's settled().
 */
export type FromWorker =
  | { type: "running" }
  | { type: "idle"; received: number }
  | { type: "trace"; line: string }
  | { type: "uncaught"; text: string }
  | { type: "terminate" }
  | SharedMessage
  | ChannelMessage
  | ChannelClose;
