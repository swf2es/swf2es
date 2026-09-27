/** AS3 `int(value)`: ToInt32(ToNumber(value)). */
export function toInt(value: unknown): number {
  return Number(value) | 0;
}

/** AS3 `uint(value)`: ToUint32(ToNumber(value)). */
export function toUint(value: unknown): number {
  return Number(value) >>> 0;
}
