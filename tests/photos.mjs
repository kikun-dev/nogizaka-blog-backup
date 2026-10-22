import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

const { extractPhotoCandidates, savePhotoSource } = await import("../server/photo-acquisition.ts");
const { createPhotoZip, crc32, photoZipFolderName } = await import("../server/photo-zip.ts");
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
    await mkdir(path.join(directory, "photos", "104935"), { recursive: true });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await writeFile(path.join(directory, "photos", "104935", "photo-001.jpg"), bytes);
    assert.equal(await createPhotoZip(directory, [{
      id: "104935", date: "2026.10.22 20:00", authorName: "海邉朱莉", photos: [{ name: "photo-001.jpg" }],
    }]), true);
    const zip = await readFile(path.join(directory, "photos.zip"));
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt16LE(6), 0x0800);
    assert.equal(zip.readUInt32LE(14), crc32(bytes));
    const name = "2026-10-22_海邉朱莉_blog-104935/photo-001.jpg";
    assert.equal(zip.readUInt16LE(26), Buffer.byteLength(name));
    assert.equal(zip.subarray(30, 30 + Buffer.byteLength(name)).toString("utf8"), name);
    const centralOffset = 30 + Buffer.byteLength(name) + bytes.length;
    assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
    assert.equal(zip.readUInt16LE(centralOffset + 8), 0x0800);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("photo ZIP folder names use the post date and sanitize unsafe names", () => {
  assert.equal(photoZipFolderName({ id: "104935", date: "2026/10/22", authorName: "海邉朱莉" }),
    "2026-10-22_海邉朱莉_blog-104935");
  assert.equal(photoZipFolderName({ id: "104935", date: "2026-02-30", authorName: "A/B\\C" }),
    "日付不明_A_B_C_blog-104935");
  assert.equal(photoZipFolderName({ id: "104935", date: "", authorName: "" }),
    "日付不明_投稿者不明_blog-104935");
});

test("streams images to disk and stops an unknown-size response at the byte limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sakamichi-photo-stream-"));
  const url = "https://cdn.hinatazaka46.com/photo.jpg";
  try {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const small = await savePhotoSource(url, "hinatazaka", "https://www.hinatazaka46.com/blog", directory, 1, {
      maxBytes: 8,
      fetcher: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(jpeg); controller.close(); } }), {
        headers: { "Content-Type": "image/jpeg" },
      }),
    });
    assert.equal(small?.name, "photo-001.jpg");
    assert.deepEqual(await readFile(path.join(directory, "photo-001.jpg")), Buffer.from(jpeg));

    let produced = 0;
    const tooLarge = await savePhotoSource(url, "hinatazaka", "https://www.hinatazaka46.com/blog", directory, 2, {
      maxBytes: 8,
      fetcher: async () => new Response(new ReadableStream({ pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      } }), { headers: { "Content-Type": "image/jpeg" } }),
    });
    assert.equal(tooLarge, null);
    assert.ok(produced < 10, "the download should stop during the stream");
    assert.deepEqual(await readdir(directory), ["photo-001.jpg"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects image redirects outside the official domain", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sakamichi-photo-redirect-"));
  let requests = 0;
  try {
    const result = await savePhotoSource("https://sakurazaka46.com/photo.jpg", "sakurazaka", "https://sakurazaka46.com/blog", directory, 1, {
      fetcher: async () => { requests += 1; return Response.redirect("http://127.0.0.1/private"); },
    });
    assert.equal(result, null);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(directory), []);
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
