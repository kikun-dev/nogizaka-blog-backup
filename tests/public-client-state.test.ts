import assert from "node:assert/strict";
import { test } from "node:test";
import { canShowPhotoGallery } from "../lib/photo-gallery-visibility";
import { RECENT_PUBLIC_JOB_KEY, restoreRecentPublicJob, saveRecentPublicJob } from "../lib/recent-public-job";
import { artifactContentDisposition } from "../server/public-r2";
import { publicZipFilename } from "../server/public-download-name";
import { safeFilenamePart } from "../lib/safe-filename-part";
import type { LocalJob } from "../server/job-store";
import type { PublicJobRow } from "../server/public-store";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const now = Date.parse("2026-10-22T03:00:00Z");
const job = { id, kind: "photos", status: "running", updatedAt: new Date(now).toISOString(), photoArticles: [] } as unknown as LocalJob;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("public photo gallery waits for committed completion; local progress remains visible", () => {
  assert.equal(canShowPhotoGallery(job, true), false);
  assert.equal(canShowPhotoGallery({ ...job, status: "queued" }, true), false);
  assert.equal(canShowPhotoGallery({ ...job, status: "succeeded" }, true), true);
  assert.equal(canShowPhotoGallery({ ...job, status: "partial" }, true), true);
  assert.equal(canShowPhotoGallery({ ...job, status: "failed" }, true), false);
  assert.equal(canShowPhotoGallery(job, false), true);
});

test("recent public job is restored only after session and owned-job checks", async () => {
  const storage = memoryStorage();
  saveRecentPublicJob(storage, id);
  const calls: string[] = [];
  const result = await restoreRecentPublicJob(storage, async (url) => {
    calls.push(url);
    return Response.json(url === "/api/access-session" ? { authenticated: true } : { job, workerOffline: true });
  }, now);
  assert.deepEqual(calls, ["/api/access-session", `/api/jobs/${id}`]);
  assert.equal(result.job?.id, id);
  assert.equal(result.workerOffline, true);
});

test("expired session and a job from another session cannot be restored", async () => {
  const storage = memoryStorage();
  saveRecentPublicJob(storage, id);
  let jobFetched = false;
  const expired = await restoreRecentPublicJob(storage, async (url) => {
    if (url.includes("/jobs/")) jobFetched = true;
    return Response.json({ authenticated: false });
  }, now);
  assert.equal(expired.job, null);
  assert.equal(expired.authenticated, false);
  assert.equal(jobFetched, false);
  assert.equal(storage.getItem(RECENT_PUBLIC_JOB_KEY), null);

  saveRecentPublicJob(storage, id);
  const otherSession = await restoreRecentPublicJob(storage, async (url) => url === "/api/access-session"
    ? Response.json({ authenticated: true }) : Response.json({ error: "not found" }, { status: 404 }), now);
  assert.equal(otherSession.job, null);
  assert.equal(storage.getItem(RECENT_PUBLIC_JOB_KEY), null);
});

test("expired results are discarded, temporary API failure keeps the recent id", async () => {
  const storage = memoryStorage();
  saveRecentPublicJob(storage, id);
  const oldJob = { ...job, status: "succeeded", updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString() };
  const expired = await restoreRecentPublicJob(storage, async (url) => Response.json(url === "/api/access-session"
    ? { authenticated: true } : { job: oldJob }), now);
  assert.equal(expired.job, null);
  assert.equal(storage.getItem(RECENT_PUBLIC_JOB_KEY), null);

  saveRecentPublicJob(storage, id);
  await assert.rejects(restoreRecentPublicJob(storage, async (url) => url === "/api/access-session"
    ? Response.json({ authenticated: true }) : Response.json({}, { status: 503 }), now));
  assert.equal(storage.getItem(RECENT_PUBLIC_JOB_KEY), id);
});

test("ZIP names include group, member and completion date for both kinds", () => {
  const row = {
    kind: "photos", author_group: "nogizaka", author_id: "42", author_name: "遠藤さくら",
    finished_at: "2026-10-21T16:05:00Z", updated_at: "2026-10-21T16:05:00Z",
  } as Pick<PublicJobRow, "kind" | "author_group" | "author_name" | "author_id" | "finished_at" | "updated_at">;
  const photos = publicZipFilename(row);
  assert.deepEqual(photos, {
    unicode: "乃木坂46-遠藤さくら-2026-10-22-写真.zip",
    ascii: "nogizaka46-42-2026-10-22-photos.zip",
  });
  assert.deepEqual(publicZipFilename({ ...row, kind: "blog" }), {
    unicode: "乃木坂46-遠藤さくら-2026-10-22-ブログ.zip",
    ascii: "nogizaka46-42-2026-10-22-blogs.zip",
  });
  assert.equal(artifactContentDisposition(photos), `attachment; filename="${photos.ascii}"; filename*=UTF-8''${encodeURIComponent(photos.unicode)}`);
  assert.equal(artifactContentDisposition(), "inline");
});

test("ZIP name segments strip forbidden, control and reserved characters", () => {
  assert.equal(safeFilenamePart(" A/B:\\C*?<>|. ", "member"), "A_B__C_____");
  assert.equal(safeFilenamePart("CON.txt", "member"), "member");
  assert.equal(safeFilenamePart("\u202e", "member"), "member");
});
