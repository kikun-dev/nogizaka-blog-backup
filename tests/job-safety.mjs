import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./job-store") return nextResolve("./job-store.ts", context);
    if (specifier === "@/lib/selection") return nextResolve("../lib/selection.ts", context);
    return nextResolve(specifier, context);
  },
});

const { checkLocalAccess } = await import("../server/local-access.ts");
const { LocalJobRunner } = await import("../server/job-runner.ts");
const { collectBulkBatch } = await import("../lib/selection.ts");
const { ArchiveOutputLimitError } = await import("../lib/archive/index.mjs");

test("module reload keeps the active runner", async () => {
  const first = (await import("../server/job-runner.ts")).localJobRunner;
  const reloaded = (await import("../server/job-runner.ts?reload-test")).localJobRunner;
  assert.equal(reloaded, first);
});

test("job API requires a configured matching bearer token", () => {
  const previous = process.env.LOCAL_ACCESS_TOKEN;
  try {
    delete process.env.LOCAL_ACCESS_TOKEN;
    assert.equal(checkLocalAccess(new Request("http://localhost/api/jobs"))?.status, 503);
    process.env.LOCAL_ACCESS_TOKEN = "a-long-local-secret";
    assert.equal(checkLocalAccess(new Request("http://localhost/api/jobs"))?.status, 401);
    assert.equal(checkLocalAccess(new Request("http://localhost/api/jobs", {
      headers: { Authorization: "Bearer wrong" },
    }))?.status, 401);
    assert.equal(checkLocalAccess(new Request("http://localhost/api/jobs", {
      headers: { Authorization: "Bearer a-long-local-secret" },
    })), null);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_ACCESS_TOKEN;
    else process.env.LOCAL_ACCESS_TOKEN = previous;
  }
});

test("runner executes one job and bounds its waiting queue", async () => {
  let nextId = 0;
  const started = [];
  const releases = [];
  const store = {
    async failInterrupted() {},
    async create(articleUrl) { return { id: String(++nextId), articleUrl }; },
  };
  const runner = new LocalJobRunner(store, async (job) => {
    started.push(job.id);
    await new Promise((resolve) => releases.push(resolve));
  });
  const accepted = await Promise.all(Array.from({ length: 11 }, (_, index) => runner.submit(`https://example.com/${index}`)));
  assert.equal(accepted.filter(Boolean).length, 11);
  assert.equal(started.length, 1);
  assert.equal(await runner.submit("https://example.com"), null);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 2);
  while (releases.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started.length, 11);
});

test("store marks unfinished jobs failed after restart", async () => {
  const originalDirectory = process.cwd();
  const directory = await mkdtemp(path.join(os.tmpdir(), "sakamichi-job-test-"));
  try {
    process.chdir(directory);
    const { localJobStore } = await import("../server/job-store.ts?recovery-test");
    const running = await localJobStore.create("https://example.com");
    await localJobStore.update(running.id, { status: "running" });
    const queued = await localJobStore.create("https://example.com");
    const succeeded = await localJobStore.create("https://example.com");
    await localJobStore.update(succeeded.id, { status: "succeeded" });
    await localJobStore.update(succeeded.id, { error: "old failure" });
    await localJobStore.failInterrupted();
    await localJobStore.update(succeeded.id, { status: "failed", error: "late failure" });
    assert.equal((await localJobStore.get(running.id)).status, "failed");
    assert.equal((await localJobStore.get(queued.id)).status, "failed");
    assert.equal((await localJobStore.get(succeeded.id)).status, "succeeded");
    assert.equal((await localJobStore.get(succeeded.id)).error, undefined);
  } finally {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed full backup resumes the same job and preserves progress", async () => {
  const saved = { id: "backup-1", articleUrl: "https://example.com", fullBackup: true,
    status: "failed", savedCount: 12, outputBytes: 4096, nextCursor: { page: 2, offset: 3 },
    savedDirectories: ["first", "second"] };
  const started = [];
  const store = {
    async failInterrupted() {},
    async get(id) { return id === saved.id ? { ...saved } : null; },
    async update(id, change) { assert.equal(id, saved.id); Object.assign(saved, change); return { ...saved }; },
  };
  const runner = new LocalJobRunner(store, async (job) => { started.push(job); });
  const resumed = await runner.resumeFullBackup(saved.id);
  assert.equal(resumed.id, saved.id);
  assert.equal(resumed.savedCount, 12);
  assert.deepEqual(resumed.nextCursor, { page: 2, offset: 3 });
  assert.equal(resumed.status, "queued");
  assert.equal(await runner.resumeFullBackup(saved.id), null);
  assert.equal(started.length, 1);
});

async function runLimitedBackup(articleLimit, byteLimit, pageOverrides) {
  const jobs = new Map();
  const zipContents = new Map();
  let nextId = 0;
  const store = {
    async failInterrupted() {},
    async create(articleUrl, options) {
      const job = { id: `part-${++nextId}`, articleUrl, ...options, status: "queued",
        outputDirectory: `part-${nextId}`, log: [] };
      jobs.set(job.id, job);
      return { ...job };
    },
    async get(id) { return jobs.has(id) ? { ...jobs.get(id) } : null; },
    async update(id, change) {
      const job = { ...jobs.get(id), ...change };
      jobs.set(id, job);
      return { ...job };
    },
  };
  const author = { id: "123", name: "テスト", group: "nogizaka", type: "member" };
  const articles = [1, 2, 3].map((id) => ({ id: String(id), url: `https://example.com/${id}`, author }));
  const pages = pageOverrides ?? { 1: { items: articles, page: 1, hasNext: false } };
  const services = {
    ArchiveOutputLimitError,
    collectBulkBatch,
    async getArticlePage(_group, _authorId, page) {
      return pages[page] ?? null;
    },
    async archiveWebArticles({ articles: batch, maxBytes }, { onProgress }) {
      const saved = [];
      let bytes = 0;
      for (const article of batch) {
        if (bytes + 10 > maxBytes) throw new ArchiveOutputLimitError(maxBytes);
        bytes += 10;
        const record = { directory: `dir/${article.id}`, metadata: { id: article.id } };
        saved.push(record);
        await onProgress(saved.length, bytes, record);
      }
      return { saved, totalBytes: bytes };
    },
    async createStreamingBlogZip(output, directories) {
      zipContents.set(output, directories);
      return `${output}/blogs.zip`;
    },
  };
  const runner = new LocalJobRunner(store, undefined, { services, articleLimit, byteLimit });
  async function completed(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await store.get(id);
      if (job.status === "succeeded" || job.status === "failed") return job;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("job did not finish");
  }
  const first = await runner.submitFullBackup(author, pages[1].items[0].url);
  return { runner, first: await completed(first.id), completed, zipContents, pages };
}

test("article limit packages a ZIP and continues from the first unarchived blog", async () => {
  const { runner, first, completed, zipContents } = await runLimitedBackup(2, 100);
  assert.equal(first.status, "succeeded");
  assert.equal(first.savedCount, 2);
  assert.equal(first.backupStopReason, "article-limit");
  assert.deepEqual(first.nextCursor, { page: 1, offset: 2, afterArticleId: "2" });
  assert.deepEqual(zipContents.get(first.outputDirectory), ["dir/1", "dir/2"]);
  const next = await runner.continueFullBackup(first.id);
  const finished = await completed(next.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.savedCount, 1);
  assert.equal(finished.backupStopReason, undefined);
  assert.deepEqual(finished.priorPartIds, [first.id]);
  assert.deepEqual(zipContents.get(finished.outputDirectory), ["dir/3"]);
  assert.equal((await runner.continueFullBackup(first.id)).id, next.id);
});

test("byte limit packages completed blogs and leaves the oversized blog for the next job", async () => {
  const { first, zipContents } = await runLimitedBackup(10, 15);
  assert.equal(first.status, "succeeded");
  assert.equal(first.savedCount, 1);
  assert.equal(first.backupStopReason, "size-limit");
  assert.deepEqual(first.nextCursor, { page: 1, offset: 1, afterArticleId: "1" });
  assert.deepEqual(zipContents.get(first.outputDirectory), ["dir/1"]);
});

test("an uncertain empty listing fails after saved articles and can resume", async () => {
  const author = { id: "123", name: "テスト", group: "nogizaka", type: "member" };
  const articles = Array.from({ length: 11 }, (_, index) => ({
    id: String(index + 1), url: `https://example.com/${index + 1}`, author,
  }));
  const pages = { 1: { items: articles.slice(0, 10), page: 1, hasNext: true }, 2: null };
  const { runner, first, completed, zipContents } = await runLimitedBackup(20, 1000, pages);
  assert.equal(first.status, "failed");
  assert.equal(first.savedCount, 10);
  assert.match(first.error, /公式一覧を確認できませんでした/);
  assert.equal(zipContents.size, 0);
  pages[2] = { items: articles.slice(10), page: 2, hasNext: false };
  const resumed = await runner.resumeFullBackup(first.id);
  const finished = await completed(resumed.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.savedCount, 11);
  assert.deepEqual(zipContents.get(first.outputDirectory), articles.map(({ id }) => `dir/${id}`));
});

test("a deleted cursor article is recovered across ZIP parts without duplicates", async () => {
  const { runner, first, completed, zipContents, pages } = await runLimitedBackup(2, 100);
  assert.equal(first.status, "succeeded");
  pages[1] = { ...pages[1], items: pages[1].items.filter(({ id }) => id !== "2") };
  const continuation = await runner.continueFullBackup(first.id);
  const finished = await completed(continuation.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.savedCount, 1);
  assert.deepEqual(zipContents.get(finished.outputDirectory), ["dir/3"]);
});

test("partial blog job keeps successful ZIP, retries only failures, and deduplicates starts", async () => {
  const jobs = new Map();
  let nextId = 0;
  const archived = [];
  const zipped = [];
  const author = { id: "member", name: "テスト", group: "nogizaka", type: "member" };
  const articles = ["1", "2", "3"].map((id) => ({ id, url: `https://example.com/${id}`, title: `記事${id}`, date: "2026-10-21", author }));
  const store = {
    async failInterrupted() {},
    async create(articleUrl, options) {
      const job = { id: `job-${++nextId}`, articleUrl, ...options, status: "queued", outputDirectory: `job-${nextId}`, log: [] };
      jobs.set(job.id, job);
      return { ...job };
    },
    async get(id) { return jobs.has(id) ? { ...jobs.get(id) } : null; },
    async update(id, change) {
      const job = { ...jobs.get(id), ...change };
      jobs.set(id, job);
      return { ...job };
    },
  };
  const jobServices = {
    async archiveWebArticles({ articles: batch }, { onStart, onFailure, onProgress, continueOnError }) {
      assert.equal(continueOnError, true);
      archived.push(batch.map(({ id }) => id));
      const saved = [];
      for (const [index, article] of batch.entries()) {
        await onStart(article, index);
        if (article.id === "2" && archived.length === 1) {
          await onFailure(article, new Error("private stack detail"));
          continue;
        }
        const record = { directory: `dir/${article.id}`, metadata: article };
        saved.push(record);
        await onProgress(saved.length, saved.length * 10, record);
      }
      return { saved, totalBytes: saved.length * 10 };
    },
    async createBlogZip(_directory, directories) { zipped.push(directories); },
    async acquirePhotos() { throw new Error("unexpected photos"); },
    async createPhotoZip() { throw new Error("unexpected photos ZIP"); },
  };
  const runner = new LocalJobRunner(store, undefined, { jobServices });
  const [first, duplicate] = await Promise.all([
    runner.submitBlogs(articles, author), runner.submitBlogs(articles, author),
  ]);
  assert.equal(duplicate.id, first.id);
  async function completed(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await store.get(id);
      if (["succeeded", "partial", "failed"].includes(job.status)) return job;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("job did not finish");
  }
  const partial = await completed(first.id);
  assert.equal(partial.status, "partial");
  assert.equal(partial.savedCount, 2);
  assert.deepEqual(partial.articleResults.map(({ status }) => status), ["succeeded", "failed", "succeeded"]);
  assert.doesNotMatch(JSON.stringify(partial), /private stack detail/);
  assert.deepEqual(zipped[0], ["dir/1", "dir/3"]);
  const [retry, duplicateRetry] = await Promise.all([runner.retryFailed(first.id), runner.retryFailed(first.id)]);
  assert.equal(duplicateRetry.id, retry.id);
  const recovered = await completed(retry.id);
  assert.equal(recovered.status, "succeeded");
  assert.deepEqual(archived, [["1", "2", "3"], ["2"]]);
  assert.deepEqual(zipped[1], ["dir/2"]);
});

test("photo job treats zero images as success and retries an article with failed images", async () => {
  const jobs = new Map();
  let nextId = 0;
  const calls = [];
  const author = { id: "member", name: "テスト", group: "nogizaka", type: "member" };
  const articles = ["1", "2"].map((id) => ({ id, url: `https://example.com/${id}`, title: `記事${id}`, date: "2026-10-21", author }));
  const store = {
    async failInterrupted() {},
    async create(articleUrl, options) {
      const job = { id: `photo-${++nextId}`, articleUrl, ...options, status: "queued", outputDirectory: `photo-${nextId}`, log: [] };
      jobs.set(job.id, job);
      return { ...job };
    },
    async get(id) { return jobs.has(id) ? { ...jobs.get(id) } : null; },
    async update(id, change) {
      const job = { ...jobs.get(id), ...change };
      jobs.set(id, job);
      return { ...job };
    },
  };
  const jobServices = {
    async acquirePhotos(batch, _output, onProgress) {
      calls.push(batch.map(({ id }) => id));
      const results = [];
      for (const article of batch) {
        await onProgress([...results], article);
        results.push({ id: article.id, title: article.title, date: article.date, authorName: author.name,
          photos: article.id === "2" ? [{ name: "1.jpg", mimeType: "image/jpeg" }] : [],
          detected: article.id === "2" ? 2 : 0, failed: article.id === "2" && calls.length === 1 ? 1 : 0 });
        await onProgress([...results]);
      }
      return results;
    },
    async createPhotoZip() { return true; },
    async archiveWebArticles() { throw new Error("unexpected blogs"); },
    async createBlogZip() { throw new Error("unexpected blog ZIP"); },
  };
  const runner = new LocalJobRunner(store, undefined, { jobServices });
  const first = await runner.submitPhotos(articles);
  async function completed(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await store.get(id);
      if (["succeeded", "partial", "failed"].includes(job.status)) return job;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("job did not finish");
  }
  const partial = await completed(first.id);
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.articleResults.map(({ status }) => status), ["succeeded", "failed"]);
  const retry = await runner.retryFailed(first.id);
  assert.equal((await completed(retry.id)).status, "succeeded");
  assert.deepEqual(calls, [["1", "2"], ["2"]]);
});
