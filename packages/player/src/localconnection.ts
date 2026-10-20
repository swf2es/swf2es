// LocalConnection's registry is shared by the VMs of one player. Delivery
// uses their existing host-event queues: an idle registry does no frame work.

export const LOCAL_MESSAGE_LIMIT = 40 * 1024;

export type LocalMessage =
  | { readonly bytes: Uint8Array<ArrayBuffer>; readonly encoding: 0 }
  | {
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly encoding: 3;
      /** A modern message is converted only if a legacy VM receives it. */
      legacy(): Uint8Array;
    };

export interface LocalEndpoint {
  readonly owner: object;
  readonly domain: string;
  readonly secure: boolean;
  key: string | null;
  alive(): boolean;
  allows(sender: LocalEndpoint): boolean;
  defer(deliver: () => void): void;
  status(success: boolean): void;
  receive(method: string, message: LocalMessage): void;
}

const lower = (name: string) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

export function localDomain(url: string): { domain: string; secure: boolean } {
  try {
    const parsed = new URL(url);

    return {
      domain: parsed.protocol === "file:" || !parsed.hostname ? "localhost" : parsed.hostname,
      secure: parsed.protocol === "https:",
    };
  } catch {
    return { domain: "localhost", secure: false };
  }
}

export function localMethodAllowed(name: string): boolean {
  switch (name) {
    case "send":
    case "connect":
    case "close":
    case "allowDomain":
    case "allowInsecureDomain":
    case "domain":
      return false;
    default:
      return name.length !== 0;
  }
}

export class LocalConnections {
  private readonly listeners = new Map<string, LocalEndpoint>();

  connect(endpoint: LocalEndpoint, name: string): boolean {
    if (!endpoint.alive() || endpoint.key !== null || name === "" || name.includes(":")) {
      return false;
    }

    const key = lower(name.startsWith("_") ? name : `${endpoint.domain}:${name}`);
    const previous = this.listeners.get(key);
    if (previous?.alive()) {
      return false;
    }

    if (previous) {
      previous.key = null;
    }

    this.listeners.set(key, endpoint);
    endpoint.key = key;
    return true;
  }

  close(endpoint: LocalEndpoint): boolean {
    const key = endpoint.key;
    if (key === null) {
      return false;
    }

    this.listeners.delete(key);
    endpoint.key = null;
    return true;
  }

  send(source: LocalEndpoint, name: string, method: string, message: LocalMessage): void {
    const key = lower(
      name.startsWith("_") || name.includes(":") ? name : `${source.domain}:${name}`,
    );
    // A receiver must exist both now and at delivery; another may replace it meanwhile.
    const existed = this.listeners.get(key)?.alive() ?? false;
    source.defer(() => {
      if (!source.alive()) {
        return;
      }

      const receiver = existed ? this.listeners.get(key) : undefined;
      if (!receiver?.alive()) {
        source.status(false);
        return;
      }

      try {
        source.status(true);
      } finally {
        if (
          receiver.alive() &&
          source.domain !== "" &&
          receiver.domain !== "" &&
          receiver.allows(source)
        ) {
          receiver.receive(method, message);
        }
      }
    });
  }

  destroy(owner: object): void {
    for (const endpoint of this.listeners.values()) {
      if (endpoint.owner === owner) {
        this.close(endpoint);
      }
    }
  }
}
