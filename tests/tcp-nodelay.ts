// Whether a node:net socket sends at once (TCP_NODELAY). Node has no getter
// for it, but keeps what it last gave the handle under a symbol of its own,
// set from connect's noDelay and by setNoDelay: that is what is read.
import { Socket } from "node:net";

/** The sockets `open` connects with node:net, while it runs: a proxy's own later ones are not. */
export function socketsOpenedBy(open: () => void): Socket[] {
  const opened: Socket[] = [];
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    opened.push(this);
    return (connect as (...a: unknown[]) => Socket).apply(this, args);
  } as typeof connect;
  try {
    open();
  } finally {
    Socket.prototype.connect = connect;
  }

  return opened;
}

export function noDelayOf(socket: Socket): boolean {
  const key = Object.getOwnPropertySymbols(socket).find((s) => s.description === "kSetNoDelay");
  if (key === undefined) {
    throw new Error("this node keeps TCP_NODELAY under no kSetNoDelay: read it some other way");
  }

  return (socket as unknown as Record<symbol, boolean>)[key];
}
