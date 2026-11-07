// ZIP archives for the tests: what readZip reads and what an AIR package
// is, each file stored or deflated, without CRCs, which nothing here checks.
import { deflateRawSync } from "node:zlib";

/** A ZIP archive of `files`, each stored or deflated as given, with a comment after its end record. */
export function zip(
  files: { name: string; data: string | Uint8Array; deflated?: boolean }[],
  comment = "",
): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const data = file.deflated ? new Uint8Array(deflateRawSync(raw)) : raw;
    const header = (signature: number, size: number) => {
      const bytes = new Uint8Array(size);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, signature, true);
      return { bytes, view };
    };
    // 2026-11-07 12:34:56, as DOS writes it.
    const time = (12 << 11) | (34 << 5) | 28;
    const date = ((2026 - 1980) << 9) | (11 << 5) | 7;
    const local = header(0x04034b50, 30);
    local.view.setUint16(8, file.deflated ? 8 : 0, true);
    local.view.setUint16(10, time, true);
    local.view.setUint16(12, date, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, raw.length, true);
    local.view.setUint16(26, name.length, true);
    locals.push(local.bytes, name, data);
    const central = header(0x02014b50, 46);
    central.view.setUint16(10, file.deflated ? 8 : 0, true);
    central.view.setUint16(12, time, true);
    central.view.setUint16(14, date, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, raw.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    centrals.push(central.bytes, name);
    offset += 30 + name.length + data.length;
  }

  const directory = centrals.reduce((n, b) => n + b.length, 0);
  const note = encoder.encode(comment);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, directory, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, note.length, true);
  const parts = [...locals, ...centrals, end, note];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}
