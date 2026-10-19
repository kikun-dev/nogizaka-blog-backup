import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import path from "node:path";

const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

async function checksum(file: string) {
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(file)) {
    for (const byte of chunk as Buffer) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function createBlogZip(output: string, directories: string[], maxBytes = 512 * 1024 * 1024) {
  const entries = directories.flatMap((directory) => ["blog.pdf", "blog.mhtml", "metadata.json"].map((name) => ({
    file: path.join(output, directory, name),
    name: `${directory.split(path.sep).join("/")}/${name}`,
  })));
  const destination = path.join(output, "blogs.zip");
  const zip = await open(destination, "w");
  const central: Buffer[] = [];
  let offset = 0;
  async function write(bytes: Buffer) {
    let written = 0;
    while (written < bytes.length) {
      const result = await zip.write(bytes, written, bytes.length - written);
      if (!result.bytesWritten) throw new Error("ZIPを書き込めませんでした。");
      written += result.bytesWritten;
    }
    offset += bytes.length;
    if (offset > maxBytes || offset > 0xffffffff) throw new Error("ZIPの容量が512 MBを超えました。取得範囲を小さくしてください。");
  }
  try {
    for (const entry of entries) {
      const info = await stat(entry.file);
      const name = Buffer.from(entry.name, "utf8");
      if (!info.isFile() || info.size > 0xffffffff || name.length > 0xffff) throw new Error("ZIPに追加できないファイルがあります。");
      const crc = await checksum(entry.file);
      const start = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(info.size, 18);
      local.writeUInt32LE(info.size, 22);
      local.writeUInt16LE(name.length, 26);
      await write(local);
      await write(name);
      for await (const chunk of createReadStream(entry.file)) await write(chunk as Buffer);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(info.size, 20);
      record.writeUInt32LE(info.size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(start, 42);
      central.push(record, name);
    }
    const centralStart = offset;
    for (const part of central) await write(part);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    await write(end);
  } catch (error) {
    await zip.close();
    await unlink(destination).catch(() => {});
    throw error;
  }
  await zip.close();
  return destination;
}
