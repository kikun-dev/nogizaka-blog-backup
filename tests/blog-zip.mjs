import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBlogZip } from "../server/blog-zip.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "blog-zip-test-"));
const directory = path.join("Nogizaka", "投稿者", "2026-10-20_123_ブログ");
await mkdir(path.join(root, directory), { recursive: true });
for (const file of ["blog.pdf", "blog.mhtml", "metadata.json"]) {
  await writeFile(path.join(root, directory, file), `${file}:内容`);
}
const zip = await createBlogZip(root, [directory]);
assert.ok((await stat(zip)).size > 100);
const bytes = await readFile(zip);
let position = 0;
for (const file of ["blog.pdf", "blog.mhtml", "metadata.json"]) {
  assert.equal(bytes.readUInt32LE(position), 0x04034b50);
  const size = bytes.readUInt32LE(position + 18);
  const nameLength = bytes.readUInt16LE(position + 26);
  const name = bytes.subarray(position + 30, position + 30 + nameLength).toString();
  assert.equal(name, `${directory.split(path.sep).join("/")}/${file}`);
  assert.equal(bytes.subarray(position + 30 + nameLength, position + 30 + nameLength + size).toString(), `${file}:内容`);
  position += 30 + nameLength + size;
}
assert.equal(bytes.readUInt32LE(position), 0x02014b50);
assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
await assert.rejects(createBlogZip(root, [directory], 50), /容量/);
await assert.rejects(stat(zip), { code: "ENOENT" });
console.log("Blog ZIP integrity and size limits passed");
