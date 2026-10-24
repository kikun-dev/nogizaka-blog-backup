import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loginWithAccessCode } from "../server/public-access";
import { publicArtifactRedirect, publicJobStatus, retryPublicJob } from "../server/public-api";
import { signedArtifactUrl } from "../server/public-r2";
import { getOwnedPublicJob, type ArtifactRow, type PublicJobRow, type PublicRequest } from "../server/public-store";

const jobId = "11111111-1111-4111-8111-111111111111";
const blogJobId = "33333333-3333-4333-8333-333333333333";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = Date.now();

function request(path: string, session?: "A" | "B" | "expired") {
  return new Request(`https://app.example${path}`, { headers: session ? { cookie: `test_session=${session}` } : {} });
}

function requireSession(input: Request) {
  const cookie = input.headers.get("cookie");
  if (cookie === "test_session=A") return Promise.resolve({ id: ownerA });
  if (cookie === "test_session=B") return Promise.resolve({ id: ownerB });
  return Promise.resolve({ denied: Response.json({ error: "アクセスコードを入力してください。" }, { status: 401 }) });
}

function job(kind: "photos" | "blog" = "photos", status: PublicJobRow["status"] = "succeeded"): PublicJobRow {
  return {
    id: jobId, owner_session_id: ownerA, kind, status, request: {} as PublicRequest,
    state: {}, author_group: "nogizaka", author_id: "42", author_name: "Test", author_type: "member",
    lease_owner: null, lease_generation: 1, lease_expires_at: null,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    finished_at: new Date(now).toISOString(), error: null, retry_of_job_id: null,
  };
}

function artifact(kind: ArtifactRow["kind"], expiresAt = now + 24 * 60 * 60 * 1000): ArtifactRow {
  return {
    id: "22222222-2222-4222-8222-222222222222", job_id: jobId, kind,
    article_id: kind === "photo" ? "article-1" : undefined,
    name: kind === "photo" ? "photo-001.jpg" : undefined,
    object_key: `${jobId}/1/${kind}`, mime_type: "application/octet-stream", byte_size: 12,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

test("owned jobs and all three artifact routes allow A but reject B and anonymous access before signing", async () => {
  let signatures = 0;
  let artifactReads = 0;
  const deps = {
    requireSession,
    getOwnedJob: async (id: string, owner: string) => getOwnedPublicJob(id, owner,
      async () => ({ ...job(id === blogJobId ? "blog" : "photos"), id })),
    findArtifact: async (id: string, kind: ArtifactRow["kind"]) => {
      artifactReads++;
      return { ...artifact(kind), job_id: id };
    },
    activeSession: async (owner: string) => owner === ownerA,
    signUrl: async () => { signatures++; return "https://signed.example/object"; },
  };
  const statusDeps = {
    requireSession, recoverJobs: async () => {}, getOwnedJob: deps.getOwnedJob,
    lastWorkerSeen: async () => null,
  };
  assert.equal((await publicJobStatus(request(`/api/jobs/${jobId}`, "A"), jobId, statusDeps)).status, 200);
  assert.equal((await publicJobStatus(request(`/api/jobs/${jobId}`, "B"), jobId, statusDeps)).status, 404);
  assert.equal((await publicJobStatus(request(`/api/jobs/${jobId}`), jobId, statusDeps)).status, 401);

  for (const [id, kind, path, articleId, name] of [
    [jobId, "photo", `/api/photo-jobs/${jobId}/files/article-1/photo-001.jpg`, "article-1", "photo-001.jpg"],
    [jobId, "photo_zip", `/api/photo-jobs/${jobId}/zip`, undefined, undefined],
    [blogJobId, "blog_zip", `/api/blog-jobs/${blogJobId}/zip`, undefined, undefined],
  ] as const) {
    const own = await publicArtifactRedirect(request(path, "A"), id, kind, articleId, name, deps);
    assert.equal(own.status, 302, kind);
    assert.equal(own.headers.get("Location"), "https://signed.example/object");
    assert.equal((await publicArtifactRedirect(request(path, "B"), id, kind, articleId, name, deps)).status, 404, kind);
    assert.equal((await publicArtifactRedirect(request(path), id, kind, articleId, name, deps)).status, 401, kind);
  }
  assert.equal(artifactReads, 3, "other sessions must not even look up A's artifacts");
  assert.equal(signatures, 3, "only A's three accepted requests may create signed URLs");
});

test("expired sessions and artifacts return 401 or 404 without a new signed URL", async () => {
  let signatures = 0;
  const completed = now - 24 * 60 * 60 * 1000 - 1_000;
  const deps = {
    requireSession,
    getOwnedJob: async () => job(),
    findArtifact: async (_id: string, kind: ArtifactRow["kind"]) => artifact(kind, completed + 24 * 60 * 60 * 1000),
    activeSession: async () => true,
    signUrl: async () => { signatures++; return "https://signed.example/object"; },
  };
  for (const kind of ["photo", "photo_zip", "blog_zip"] as const) {
    const expired = await publicArtifactRedirect(request("/artifact", "A"), jobId, kind,
      kind === "photo" ? "article-1" : undefined, kind === "photo" ? "photo-001.jpg" : undefined, deps);
    assert.equal(expired.status, 404);
    assert.match((await expired.json()).error, /保存期限が切れた/);
  }
  assert.equal((await publicArtifactRedirect(request("/artifact", "expired"), jobId, "photo_zip", undefined, undefined, deps)).status, 401);
  assert.equal(signatures, 0);

  const inactive = { ...deps, findArtifact: async () => artifact("photo_zip"), activeSession: async () => false };
  assert.equal((await publicArtifactRedirect(request("/artifact", "A"), jobId, "photo_zip", undefined, undefined, inactive)).status, 401);
  assert.equal(signatures, 0);
});

test("an already issued R2 URL retains the existing five-minute signature lifetime", async () => {
  const keys = ["R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = "test-only";
  try {
    const url = new URL(await signedArtifactUrl(`${jobId}/1/photo-001.jpg`));
    assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("expired code login is rejected with 401 and does not set a session cookie", async () => {
  const before = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = "test-only-secret";
  try {
    const code = "expired-test-code";
    const response = await loginWithAccessCode(code, request("/api/access-session"), async (hash) => {
      assert.equal(hash, createHash("sha256").update(code).digest("hex"));
      return null;
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.deepEqual(await response.json(), { error: "アクセスコードを確認してください。" });
  } finally {
    if (before === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = before;
  }
});

test("stale heartbeat reports a queued job offline, and a fresh heartbeat clears it", async () => {
  let seen: string | null = null;
  const deps = {
    requireSession, recoverJobs: async () => {},
    getOwnedJob: async () => job("blog", "queued"), lastWorkerSeen: async () => seen,
  };
  const read = async () => {
    const response = await publicJobStatus(request(`/api/jobs/${jobId}`, "A"), jobId, deps);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await read()).workerOffline, true);
  seen = new Date(Date.now() - 46_000).toISOString();
  assert.equal((await read()).workerOffline, true);
  seen = new Date().toISOString();
  assert.equal((await read()).workerOffline, false);
});

test("retry accepts failed articles only and refuses completed or nonretryable jobs", async () => {
  const requestedArticles = [
    { id: "one", title: "Saved", url: "https://example.com/one", date: "" },
    { id: "two", title: "Failed", url: "https://example.com/two", date: "" },
  ];
  const previous = job("blog", "partial");
  previous.state = {
    requestedArticles, requestedAuthor: { id: "42", name: "Test", group: "nogizaka", type: "member", listUrl: "" },
    articleResults: [
      { id: "one", title: "Saved", date: "", status: "succeeded" },
      { id: "two", title: "Failed", date: "", status: "failed", message: "取得失敗" },
    ],
  } as typeof previous.state;
  let enqueued: PublicRequest | undefined;
  const deps = {
    requireSession,
    getOwnedJob: async (_id: string, owner: string) => owner === ownerA ? previous : null,
    enqueueJob: async (_owner: string, _kind: "blog" | "photos", requestData: PublicRequest) => {
      enqueued = requestData;
      return job("blog", "queued");
    },
  };
  const retryRequest = () => new Request(`https://app.example/api/jobs/${jobId}/retry`, {
    method: "POST", headers: { cookie: "test_session=A" },
  });
  const accepted = await retryPublicJob(retryRequest(), jobId, deps);
  assert.equal(accepted.status, 202);
  assert.deepEqual((enqueued as Extract<PublicRequest, { retryArticles: unknown }>).retryArticles.map((article) => article.id), ["two"]);
  previous.status = "succeeded";
  enqueued = undefined;
  assert.equal((await retryPublicJob(retryRequest(), jobId, deps)).status, 404);
  previous.status = "partial";
  previous.state.articleResults = [{ id: "one", title: "Saved", date: "", status: "succeeded" }];
  assert.equal((await retryPublicJob(retryRequest(), jobId, deps)).status, 404);
  assert.equal((await retryPublicJob(retryRequest(), jobId, { ...deps, getOwnedJob: async () => null })).status, 404);
  assert.equal(enqueued, undefined, "rejected retry must not enqueue a job");
});
