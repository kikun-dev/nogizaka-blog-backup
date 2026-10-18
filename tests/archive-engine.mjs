import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAuthorStore } from "../lib/archive/author-store.mjs";
import { GROUPS } from "../lib/archive/groups.mjs";
import { assertSameAuthor, markArticleVisited } from "../lib/archive/identity.mjs";
import { sameAuthor } from "../lib/archive/paths.mjs";
import { openArticle } from "../lib/archive/source.mjs";
import { normalizeArticleUrl } from "../lib/archive/urls.mjs";

test("URL normalization keeps a non-member cd and rejects foreign origins", () => {
  const url = normalizeArticleUrl("https://www.nogizaka46.com/s/n46/diary/detail/104598?cd=STAFF&ima=1#top");
  assert.equal(url, "https://www.nogizaka46.com/s/n46/diary/detail/104598?cd=STAFF");
  assert.throws(() => normalizeArticleUrl("http://www.nogizaka46.com/s/n46/diary/detail/104598"), /HTTPS/);
  assert.throws(() => normalizeArticleUrl("https://example.com/s/n46/diary/detail/104598"), /対応している/);
  assert.throws(() => normalizeArticleUrl("https://www.hinatazaka46.com/s/official/diary/detail/1", undefined, "nogizaka"), /別グループ/);
});

test("author identity and duplicate protection also work for special authors", () => {
  for (const name of ["5期生", "乃木坂46運営スタッフ", "ポカ", "公式ゲスト"]) {
    assert.equal(sameAuthor(` ${name} `, name), true);
    assert.doesNotThrow(() => assertSameAuthor(name, ` ${name} `));
  }
  assert.throws(() => assertSameAuthor("5期生", "6期生"), /別の投稿主体/);
  const visited = new Set();
  markArticleVisited(visited, "123");
  assert.throws(() => markArticleVisited(visited, "123"), /同じブログ/);
});

test("author store migrates a legacy index and upserts records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sakamichi-author-"));
  try {
    const group = GROUPS[0];
    const directory = path.join(root, group.directory, "5期生");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "index.json"), JSON.stringify({
      memberName: "5期生", group: group.key, posts: [{ id: "1", title: "旧記事" }],
    }));
    const store = await openAuthorStore({ outputRoot: root, group, startUrl: "https://example.com", authorName: "5期生" });
    const paths = store.postPaths({ id: "1", date: "2026-10-19", title: "記事" });
    assert.match(paths.pdfPath, /5期生\/2026-10-19_1_記事\.pdf$/);
    await store.savePost({ id: "1", title: "更新記事" });
    const index = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
    assert.equal(index.authorName, "5期生");
    assert.equal("memberName" in index, false);
    assert.equal(index.posts.length, 1);
    assert.equal(index.posts[0].title, "更新記事");
    await writeFile(path.join(directory, "index.json"), JSON.stringify({ authorName: "6期生", posts: [] }));
    await assert.rejects(openAuthorStore({
      outputRoot: root, group, startUrl: "", authorName: "5期生",
    }), /別の投稿主体/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("article loading retries image failures before succeeding", async () => {
  let attempts = 0;
  const waits = [];
  const page = {
    async goto() { attempts++; return { ok: () => true }; },
    locator() { return { first: () => ({ waitFor: async () => {} }) }; },
    async waitForLoadState() {},
  };
  const stats = await openArticle(page, "https://example.com/article", {
    warn: () => {},
    wait: async (ms) => { waits.push(ms); },
    loadImages: async () => {},
    countImages: async () => ({ detected: 1, loaded: attempts === 1 ? 0 : 1, failed: attempts === 1 ? 1 : 0 }),
  });
  assert.deepEqual(stats, { detected: 1, loaded: 1, failed: 0 });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [3000]);
});

test("metadata inspection reports broken images without waiting for them", async () => {
  const page = {
    async goto() { return { ok: () => true }; },
    locator() { return { first: () => ({ waitFor: async () => {} }) }; },
    async waitForLoadState() {},
  };
  const stats = await openArticle(page, "https://example.com/article", {
    verifyImages: false,
    loadImages: async () => { throw new Error("image wait should be skipped"); },
    countImages: async () => ({ detected: 9, loaded: 0, failed: 9 }),
  });
  assert.deepEqual(stats, { detected: 9, loaded: 0, failed: 9 });
});
