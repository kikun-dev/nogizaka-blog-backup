import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmedJobRequest } from "../server/public-confirmation";
import { resolvePublicJob } from "../worker/resolve-job";
import { finishUploadedArtifacts } from "../worker/artifact-lifecycle";
import type { BlogArticle, BlogAuthor } from "../lib/catalog/types";
import type { SelectionRequest } from "../lib/selection";
import type { ArtifactInput, CatalogQueryRow, PublicJobRow } from "../server/public-store";

const now = Date.parse("2026-10-22T12:00:00Z");
const author: BlogAuthor = {
  id: "42", name: "海邉朱莉", type: "member", group: "hinatazaka",
  listUrl: "https://www.hinatazaka46.com/s/official/diary/member/list?ct=42",
};
const article: BlogArticle = {
  id: "104935", title: "確認したブログ", date: "2026-10-22",
  url: "https://www.hinatazaka46.com/s/official/diary/detail/104935?cd=member", author,
};
const selection: SelectionRequest = { group: "hinatazaka", authorId: "42", content: "photos", range: "latest-one" };

function query(selected: SelectionRequest = selection): CatalogQueryRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner_session_id: "22222222-2222-4222-8222-222222222222",
    request: { kind: "selection", selection: selected },
    status: "succeeded", result: { plan: { ...selected, author, previewArticles: [article] } },
    error: null, lease_owner: null, lease_generation: 1,
    created_at: new Date(now - 1000).toISOString(),
  };
}

test("confirmed articles remain fixed when a queued job starts later", async () => {
  const frozen = confirmedJobRequest(selection, query(), now);
  assert.ok("confirmedArticles" in frozen);
  assert.deepEqual(frozen.confirmedArticles, [article]);
  const row = {
    id: "33333333-3333-4333-8333-333333333333", kind: "photos", request: frozen,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), retry_of_job_id: null,
  } as PublicJobRow;
  const resolved = await resolvePublicJob(row, "/tmp/confirmed-job");
  assert.deepEqual(resolved.requestedArticles, [article]);
  assert.equal(resolved.articleUrl, article.url);
});

test("selected articles use the confirmed URLs even if their source page shifts", () => {
  const selected: SelectionRequest = { ...selection, range: "selected", articles: [{ url: article.url, sourcePage: 2 }] };
  const frozen = confirmedJobRequest(selected, query(selected), now);
  assert.ok("confirmedArticles" in frozen);
  assert.equal(frozen.confirmedArticles[0].url, article.url);
});

test("stale, mismatched and malformed confirmation results are rejected", () => {
  assert.throws(() => confirmedJobRequest(selection, null, now), /確認結果/);
  assert.throws(() => confirmedJobRequest(selection, { ...query(), created_at: new Date(now - 16 * 60_000).toISOString() }, now), /期限/);
  assert.throws(() => confirmedJobRequest({ ...selection, content: "blog" }, query(), now), /一致しません/);
  assert.throws(() => confirmedJobRequest(selection, {
    ...query(), result: { plan: { ...selection, author, previewArticles: [{ ...article, url: "https://invalid.example/blog" }] } },
  }, now), /URL/);
});

test("unknown completion result preserves uploaded objects for R2 lifecycle cleanup", async () => {
  const uploaded: ArtifactInput[] = [{ kind: "photo_zip", object_key: "job/1/photos.zip", mime_type: "application/zip", byte_size: 10 }];
  await assert.rejects(finishUploadedArtifacts(async () => { throw new TypeError("response lost"); }, uploaded), /response lost/);
  assert.equal(uploaded.length, 0);
  const rejected: ArtifactInput[] = [{ kind: "photo_zip", object_key: "job/2/photos.zip", mime_type: "application/zip", byte_size: 10 }];
  assert.equal(await finishUploadedArtifacts(async () => false, rejected), false);
  assert.equal(rejected.length, 1);
  assert.equal(await finishUploadedArtifacts(async () => true, rejected), true);
  assert.equal(rejected.length, 0);
});
