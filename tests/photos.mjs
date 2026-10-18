import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
});

const { extractPhotoCandidates } = await import("../server/photo-acquisition.ts");
const { createPhotoZip, crc32 } = await import("../server/photo-zip.ts");
const { checkPhotoSession, photoSessionCookie } = await import("../server/photo-session.ts");

test("extracts article photos in DOM order, preferring original and larger sources", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <base href="https://sakurazaka46.com/s/s46/diary/detail/123">
      <header><img src="/logo.png"></header>
      <div class="box-article">
        <img src="/thumb.jpg" data-original="/original.jpg" srcset="/small.jpg 300w, /large.jpg 1200w">
        <div class="banner"><img src="/advert.jpg"></div>
        <img data-src="/second.jpg">
      </div>`);
    const photos = await extractPhotoCandidates(page);
    assert.equal(photos.length, 2, JSON.stringify(photos));
    assert.equal(photos[0].urls[0], "https://sakurazaka46.com/original.jpg");
    assert.ok(photos[0].urls.indexOf("https://sakurazaka46.com/large.jpg") < photos[0].urls.indexOf("https://sakurazaka46.com/small.jpg"));
    assert.equal(photos[1].urls[0], "https://sakurazaka46.com/second.jpg");
  } finally { await browser.close(); }
});

test("writes a ZIP containing the saved photos by blog", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sakamichi-photos-"));
  try {
    await mkdir(path.join(directory, "photos", "123"), { recursive: true });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await writeFile(path.join(directory, "photos", "123", "photo-001.jpg"), bytes);
    assert.equal(await createPhotoZip(directory, [{ id: "123", photos: [{ name: "photo-001.jpg" }] }]), true);
    const zip = await readFile(path.join(directory, "photos.zip"));
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt32LE(14), crc32(bytes));
    assert.equal(zip.toString("utf8", 30, 30 + "blog-123/photo-001.jpg".length), "blog-123/photo-001.jpg");
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("photo files require a valid session cookie", () => {
  const previous = process.env.LOCAL_ACCESS_TOKEN;
  try {
    process.env.LOCAL_ACCESS_TOKEN = "photo-test-secret";
    const url = "http://localhost/api/photo-jobs/123/files/123/photo-001.jpg";
    assert.equal(checkPhotoSession(new Request(url))?.status, 401);
    const cookie = photoSessionCookie(new Request(url)).split(";")[0];
    assert.equal(checkPhotoSession(new Request(url, { headers: { Cookie: cookie } })), null);
    process.env.LOCAL_ACCESS_TOKEN = "rotated-secret";
    assert.equal(checkPhotoSession(new Request(url, { headers: { Cookie: cookie } }))?.status, 401);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_ACCESS_TOKEN;
    else process.env.LOCAL_ACCESS_TOKEN = previous;
  }
});
