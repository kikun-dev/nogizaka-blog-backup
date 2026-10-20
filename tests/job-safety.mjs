import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./job-store") return nextResolve("./job-store.ts", context);
    return nextResolve(specifier, context);
  },
});

const { checkLocalAccess } = await import("../server/local-access.ts");
const { LocalJobRunner } = await import("../server/job-runner.ts");

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
  const accepted = await Promise.all(Array.from({ length: 11 }, () => runner.submit("https://example.com")));
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
