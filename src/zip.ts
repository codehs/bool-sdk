// Minimal ZIP writer for `bool deploy` — packs a file map into a valid,
// STORE-only (no compression) ZIP archive with zero dependencies. Bool's drop
// pipeline unpacks server-side, so wire size matters less than having no deps;
// source trees are small and the platform's max-archive cap still applies.
//
// Format: local file header + data per entry, then the central directory and
// end-of-central-directory record (the classic ZIP layout, no zip64 — fine for
// < 4 GB archives and < 65k files, both far beyond a project source tree).

const textEncoder = new TextEncoder();

// Standard CRC-32 (the ZIP polynomial), table-driven.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export type ZipEntry = { path: string; data: Uint8Array };

/** Build a STORE-only ZIP archive from entries. Paths are archive-relative,
 * forward-slashed (e.g. "index.html", "src/App.tsx"). */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = textEncoder.encode(entry.path);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    // Fixed DOS date/time (ZIP has no "unset"); the platform ignores mtimes.
    const dosTime = u16(0);
    const dosDate = u16(0x21); // 1980-01-01
    const common = concat([
      u16(20), // version needed
      u16(0x0800), // flags: UTF-8 names
      u16(0), // method: store
      dosTime,
      dosDate,
      u32(crc),
      u32(size), // compressed (= raw for store)
      u32(size), // uncompressed
      u16(name.length),
      u16(0), // extra len
    ]);
    const local = concat([u32(0x04034b50), common, name, entry.data]);
    locals.push(local);
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20), // version made by
        common,
        u16(0), // comment len
        u16(0), // disk start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        name,
      ]),
    );
    offset += local.length;
  }

  const centralDir = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0), // disk
    u16(0), // central dir disk
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset), // central dir offset
    u16(0), // comment len
  ]);
  return concat([...locals, centralDir, end]);
}
