import type { Value } from "./descriptors.js";
import type { Enumeration } from "./enumeration.js";

/** Object identities and the last unchanged walk over a strong Dictionary. */
export class DictionaryKeys extends Map<object, Value> {
  enumeration: Enumeration | null = null;

  override set(key: object, value: Value): this {
    this.enumeration = null;
    return super.set(key, value);
  }

  override delete(key: object): boolean {
    this.enumeration = null;
    return super.delete(key);
  }

  override clear(): void {
    this.enumeration = null;
    super.clear();
  }
}
