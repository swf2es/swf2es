// The numeric tail of a scene snapshot. Displacement maps need a separate
// pixel asset protocol before their frozen bitmap snapshots can cross threads.
import {
  type Filter,
  type FilterKind,
  filterDefaults,
} from "../../../packages/player/dist/display/filters.js";

const KINDS: readonly FilterKind[] = [
  "blur",
  "glow",
  "dropShadow",
  "bevel",
  "gradientGlow",
  "gradientBevel",
  "colorMatrix",
  "convolution",
];
const TYPES = ["inner", "outer", "full"];
// Versioned with scene.ts: a kind's default record fixes its field order and types.
const SCHEMAS = KINDS.map((kind) => Object.entries(filterDefaults(kind)).slice(1));

export function writeFilters(
  filters: readonly Filter[],
  data: Float64Array,
  start: number,
): number {
  let at = start;
  const put = (value: number) => {
    if (at >= data.length) {
      throw new RangeError("vector snapshot exceeds its slot capacity");
    }

    data[at++] = value;
  };
  put(filters.length);
  for (const filter of filters) {
    const kind = KINDS.indexOf(filter.kind);
    if (kind < 0) {
      throw new Error("experimental worker snapshot cannot share displacement map pixels yet");
    }

    const fields = SCHEMAS[kind];
    if (Object.keys(filter).length !== fields.length + 1) {
      throw new Error("invalid vector snapshot filter fields");
    }

    put(kind);
    for (const [key, sample] of fields) {
      const value = (filter as unknown as Record<string, unknown>)[key];
      if (Array.isArray(sample)) {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "number")) {
          throw new Error("invalid vector snapshot filter array");
        }

        put(value.length);
        for (const v of value) {
          put(v);
        }
      } else {
        if (typeof value !== typeof sample) {
          throw new Error("invalid vector snapshot filter value");
        }

        switch (typeof value) {
          case "number":
            put(value);
            break;
          case "boolean":
            put(Number(value));
            break;
          case "string": {
            const type = TYPES.indexOf(value);
            if (type < 0) {
              throw new Error("invalid vector snapshot filter type");
            }

            put(type);
            break;
          }
        }
      }
    }
  }

  return at;
}

export function readFilters(data: Float64Array, start: number): { filters: Filter[]; end: number } {
  let at = start;
  const take = () => {
    if (at >= data.length) {
      throw new Error("truncated vector snapshot filter");
    }

    return data[at++];
  };
  const count = take();
  if (!Number.isInteger(count) || count < 1 || count > data.length - at) {
    throw new Error("invalid vector snapshot filter count");
  }

  const filters: Filter[] = [];
  for (let i = 0; i < count; i++) {
    const kind = take();
    if (!Number.isInteger(kind) || kind < 0 || kind >= KINDS.length) {
      throw new Error("invalid vector snapshot filter kind");
    }

    const filter = filterDefaults(KINDS[kind]);
    const record = filter as unknown as Record<string, unknown>;
    for (const [key, sample] of SCHEMAS[kind]) {
      const value = take();
      if (Array.isArray(sample)) {
        if (!Number.isInteger(value) || value < 0 || value > data.length - at) {
          throw new Error("invalid vector snapshot filter array");
        }

        record[key] = Array.from(data.subarray(at, at + value));
        at += value;
      } else {
        switch (typeof sample) {
          case "number":
            record[key] = value;
            break;
          case "boolean":
            if (value !== 0 && value !== 1) {
              throw new Error("invalid vector snapshot filter boolean");
            }

            record[key] = !!value;
            break;
          case "string":
            if (!Number.isInteger(value) || value < 0 || value >= TYPES.length) {
              throw new Error("invalid vector snapshot filter type");
            }

            record[key] = TYPES[value];
            break;
        }
      }
    }

    filters.push(filter);
  }

  return { filters, end: at };
}
