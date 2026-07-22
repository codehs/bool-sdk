import { describe, expect, test } from "bun:test";
import { crc32, createZip } from "./zip.js";

const enc = new TextEncoder();

function u32At(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}
function u16At(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}

describe("crc32", () => {
  test("matches the standard check vector", () => {
    // The canonical CRC-32 test vector: "123456789" → 0xCBF43926.
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });
  test("empty input", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("createZip", () => {
  test("produces a structurally valid store-only archive", () => {
    const entries = [
      { path: "index.html", data: enc.encode("<h1>hi</h1>") },
      { path: "src/main.ts", data: enc.encode("console.log(1)\n") },
    ];
    const zip = createZip(entries);

    // First local file header signature.
    expect(u32At(zip, 0)).toBe(0x04034b50);

    // End-of-central-directory record: last 22 bytes (no comment).
    const eocd = zip.length - 22;
    expect(u32At(zip, eocd)).toBe(0x06054b50);
    expect(u16At(zip, eocd + 8)).toBe(2); // total entries
    const cdSize = u32At(zip, eocd + 12);
    const cdOffset = u32At(zip, eocd + 16);
    expect(cdOffset + cdSize).toBe(eocd);

    // First central directory header + its filename.
    expect(u32At(zip, cdOffset)).toBe(0x02014b50);
    const nameLen = u16At(zip, cdOffset + 28);
    const name = new TextDecoder().decode(
      zip.slice(cdOffset + 46, cdOffset + 46 + nameLen),
    );
    expect(name).toBe("index.html");

    // Stored (method 0) with the right CRC + sizes for entry 0.
    expect(u16At(zip, cdOffset + 10)).toBe(0); // method
    expect(u32At(zip, cdOffset + 16)).toBe(crc32(entries[0]!.data));
    expect(u32At(zip, cdOffset + 20)).toBe(entries[0]!.data.length);

    // The raw bytes are embedded verbatim right after the local header.
    const localNameLen = u16At(zip, 26);
    const dataStart = 30 + localNameLen;
    expect(new TextDecoder().decode(zip.slice(dataStart, dataStart + 11))).toBe("<h1>hi</h1>");
  });

  test("unzips with the system unzip when available (integration sanity)", async () => {
    const which = Bun.spawnSync(["sh", "-c", "command -v unzip"]);
    if (which.exitCode !== 0) return; // no unzip on this machine — skip silently
    const dir = `${process.env.TMPDIR ?? "/tmp"}/bool-sdk-zip-test-${Date.now()}`;
    const zipPath = `${dir}/a.zip`;
    await Bun.write(zipPath, createZip([{ path: "hello.txt", data: enc.encode("hello world") }]).buffer as ArrayBuffer);
    const res = Bun.spawnSync(["unzip", "-o", zipPath, "-d", dir]);
    expect(res.exitCode).toBe(0);
    expect(await Bun.file(`${dir}/hello.txt`).text()).toBe("hello world");
  });
});
