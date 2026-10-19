import { open, readFile } from "node:fs/promises";
import path from "node:path";
import type { PhotoArticle } from "./job-store";

const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Buffer): number {
  let result = 0xffffffff;
  for (const byte of bytes) result = table[(result ^ byte) & 255] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}

export async function createPhotoZip(directory: string, articles: PhotoArticle[]): Promise<boolean> {
  const entries = articles.flatMap((article) => article.photos.map((photo) => ({
    source: path.join(directory, "photos", article.id, photo.name),
    name: `blog-${article.id}/${photo.name}`,
  })));
  if (!entries.length) return false;
  const zip = await open(path.join(directory, "photos.zip"), "w");
  const central: Buffer[] = [];
  let offset = 0;
  async function write(bytes: Buffer) {
    let position = 0;
    while (position < bytes.length) {
      const result = await zip.write(bytes, position, bytes.length - position);
      if (!result.bytesWritten) throw new Error("ZIPを書き込めませんでした。");
      position += result.bytesWritten;
    }
  }
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const bytes = await readFile(entry.source);
      if (bytes.length > 0xffffffff || offset + bytes.length > 0xffffffff) throw new Error("ZIPの容量上限を超えました。");
      const crc = crc32(bytes);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(bytes.length, 18);
      local.writeUInt32LE(bytes.length, 22);
      local.writeUInt16LE(name.length, 26);
      await write(local);
      await write(name);
      await write(bytes);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(bytes.length, 20);
      record.writeUInt32LE(bytes.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);
      offset += local.length + name.length + bytes.length;
    }
    const centralOffset = offset;
    for (const part of central) { await write(part); offset += part.length; }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await write(end);
    return true;
  } finally {
    await zip.close();
  }
}
