import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBlogZip, createStreamingBlogZip } from "../server/blog-zip.ts";

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
const secondDirectory = path.join("Nogizaka", "投稿者", "2026-10-19_122_前のブログ");
await mkdir(path.join(root, secondDirectory), { recursive: true });
for (const file of ["blog.pdf", "blog.mhtml", "metadata.json"]) {
  await writeFile(path.join(root, secondDirectory, file), `2:${file}`);
}
const fullZip = await createStreamingBlogZip(root, [directory, secondDirectory]);
const fullBytes = await readFile(fullZip);
assert.equal(fullBytes.readUInt32LE(0), 0x04034b50);
assert.equal(fullBytes.readUInt32LE(fullBytes.length - 22), 0x06054b50);
for (const item of [directory, secondDirectory]) {
  for (const file of ["blog.pdf", "blog.mhtml", "metadata.json"]) {
    assert.ok(fullBytes.includes(Buffer.from(`${item.split(path.sep).join("/")}/${file}`)));
  }
}
await assert.rejects(createStreamingBlogZip(root, [directory], 50), /容量/);
assert.equal((await readdir(root)).filter((name) => name.endsWith(".part")).length, 0);
console.log("Blog ZIP integrity and size limits passed");
