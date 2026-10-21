import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWriteOrigin, isPublicMode, verifySharedCode } from "../server/public-access";

test("public access code is checked without using the local bearer token", () => {
  const mode = process.env.APP_MODE;
  const code = process.env.SHARED_ACCESS_CODE;
  const local = process.env.LOCAL_ACCESS_TOKEN;
  const vercel = process.env.VERCEL;
  try {
    process.env.APP_MODE = "public";
    process.env.SHARED_ACCESS_CODE = "a-long-shared-access-code";
    process.env.LOCAL_ACCESS_TOKEN = "a-different-local-token";
    assert.equal(isPublicMode(), true);
    assert.equal(verifySharedCode("a-long-shared-access-code"), true);
    assert.equal(verifySharedCode("a-different-local-token"), false);
    assert.equal(verifySharedCode("wrong"), false);
    delete process.env.APP_MODE;
    process.env.VERCEL = "1";
    assert.equal(isPublicMode(), true);
  } finally {
    if (mode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = mode;
    if (code === undefined) delete process.env.SHARED_ACCESS_CODE; else process.env.SHARED_ACCESS_CODE = code;
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
