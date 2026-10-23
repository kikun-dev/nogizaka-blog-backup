import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanOrphanWork, ORPHAN_MAX_AGE_MS } from "../worker/workspace";

test("startup cleanup removes aged job directories even when the PID was reused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-workspace-"));
  try {
    const stale = path.join(root, `job-${process.pid}-stale`);
    const fresh = path.join(root, `job-${process.pid}-fresh`);
    const unrelated = path.join(root, "keep-me");
    await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);
    await writeFile(path.join(stale, "old.zip"), "old");
    const now = Date.now();
    const old = new Date(now - ORPHAN_MAX_AGE_MS - 60_000);
    await utimes(stale, old, old);
    await cleanOrphanWork(root, now);
    assert.deepEqual((await readdir(root)).sort(), [`job-${process.pid}-fresh`, "keep-me"].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
