import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWriteOrigin, isPublicMode, loginWithAccessCode } from "../server/public-access";
import { catalogErrorResponse, terminalCatalogResponse } from "../server/public-catalog-api";
import type { CatalogQueryRow } from "../server/public-store";

test("public access mode does not accept the retired shared environment code", async () => {
  const mode = process.env.APP_MODE;
  const oldCode = process.env.SHARED_ACCESS_CODE;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const local = process.env.LOCAL_ACCESS_TOKEN;
  const vercel = process.env.VERCEL;
  try {
    process.env.APP_MODE = "public";
    process.env.SHARED_ACCESS_CODE = "a-long-shared-access-code";
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.LOCAL_ACCESS_TOKEN = "a-different-local-token";
    assert.equal(isPublicMode(), true);
    const response = await loginWithAccessCode("a-long-shared-access-code", new Request("https://app.example/api/access-session", { method: "POST" }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "アクセスコードを確認してください。" });
    delete process.env.APP_MODE;
    process.env.VERCEL = "1";
    assert.equal(isPublicMode(), true);
  } finally {
    if (mode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = mode;
    if (oldCode === undefined) delete process.env.SHARED_ACCESS_CODE; else process.env.SHARED_ACCESS_CODE = oldCode;
    if (secret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = secret;
    if (local === undefined) delete process.env.LOCAL_ACCESS_TOKEN; else process.env.LOCAL_ACCESS_TOKEN = local;
    if (vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = vercel;
  }
});

test("cross-origin state changes are rejected", () => {
  assert.equal(checkWriteOrigin(new Request("https://app.example/api/blog-jobs", {
    method: "POST", headers: { Origin: "https://other.example" },
  }))?.status, 403);
  assert.equal(checkWriteOrigin(new Request("https://app.example/api/blog-jobs", {
    method: "POST", headers: { Origin: "https://app.example" },
  })), null);
});

test("catalog access expiration errors are reported as authentication failures", async () => {
  const response = catalogErrorResponse(new Error("session_expired"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: "アクセスコードを入力してください。" });
});

test("terminal catalog results are withheld after the session or code is revoked", async () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111", owner_session_id: "22222222-2222-4222-8222-222222222222",
    request: { kind: "authors", group: "nogizaka" }, status: "failed", result: null, error: "revoked",
    lease_owner: null, lease_generation: 1, created_at: new Date().toISOString(),
  } as unknown as CatalogQueryRow;
  const response = await terminalCatalogResponse(row, row.owner_session_id,
    { kind: "authors", group: "nogizaka" }, async () => false);
  assert.equal(response?.status, 401);
  assert.deepEqual(await response?.json(), { error: "アクセスコードを入力してください。" });
});

test("public legacy routes cannot start the local runner", async () => {
  const mode = process.env.APP_MODE;
  const globalState = globalThis as typeof globalThis & { sakamichiLocalJobRunner?: unknown };
  try {
    process.env.APP_MODE = "public";
    const direct = await import("../app/api/jobs/route");
    const response = await direct.POST(new Request("https://app.example/api/jobs", { method: "POST" }));
    assert.equal(response.status, 404);
    const continuation = await import("../app/api/blog-jobs/[id]/continue/route");
    const continued = await continuation.POST(new Request("https://app.example/api/blog-jobs/id/continue", { method: "POST" }), {
      params: Promise.resolve({ id: "id" }),
    });
    assert.equal(continued.status, 404);
    const blog = await import("../app/api/blog-jobs/route");
    const photo = await import("../app/api/photo-jobs/route");
    const status = await import("../app/api/jobs/[id]/route");
    const blogZip = await import("../app/api/blog-jobs/[id]/zip/route");
    const photoFile = await import("../app/api/photo-jobs/[id]/files/[articleId]/[name]/route");
    const authors = await import("../app/api/catalog/[group]/authors/route");
    const articles = await import("../app/api/catalog/[group]/authors/[authorId]/articles/route");
    const selections = await import("../app/api/selections/route");
    assert.equal((await blog.POST(new Request("https://app.example/api/blog-jobs", { method: "POST" }))).status, 401);
    assert.equal((await photo.POST(new Request("https://app.example/api/photo-jobs", { method: "POST" }))).status, 401);
    assert.equal((await status.GET(new Request("https://app.example/api/jobs/id"), { params: Promise.resolve({ id: "id" }) })).status, 401);
    assert.equal((await blogZip.GET(new Request("https://app.example/api/blog-jobs/id/zip"), { params: Promise.resolve({ id: "id" }) })).status, 401);
    assert.equal((await photoFile.GET(new Request("https://app.example/api/photo-jobs/id/files/a/photo-001.jpg"), {
      params: Promise.resolve({ id: "id", articleId: "a", name: "photo-001.jpg" }),
    })).status, 401);
    assert.equal((await authors.GET(new Request("https://app.example/api/catalog/nogizaka/authors"), {
      params: Promise.resolve({ group: "nogizaka" }),
    })).status, 401);
    assert.equal((await articles.GET(new Request("https://app.example/api/catalog/nogizaka/authors/1/articles"), {
      params: Promise.resolve({ group: "nogizaka", authorId: "1" }),
    })).status, 401);
    assert.equal((await selections.POST(new Request("https://app.example/api/selections", { method: "POST" }))).status, 401);
    assert.equal(globalState.sakamichiLocalJobRunner, undefined);
  } finally {
    if (mode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = mode;
  }
});
