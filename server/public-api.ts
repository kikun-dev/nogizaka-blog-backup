import { validateSelection, SelectionError, type SelectionContent } from "@/lib/selection";
import { checkWriteOrigin, requirePublicSession } from "./public-access";
import { enqueuePublicJob, getArtifact, getOwnedPublicJob, isActiveAccessSession, publicJobView, recoverStaleJobs, workerLastSeen } from "./public-store";
import { signedArtifactUrl } from "./public-r2";
import { publicZipFilename } from "./public-download-name";
import { confirmedJobRequest } from "./public-confirmation";
import { getCatalogQuery } from "./public-store";

function submissionError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "ジョブを作成できませんでした。";
  if (/session_expired/.test(message)) {
    return Response.json({ error: "アクセスコードを入力してください。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (/session_capacity|global_capacity|submit_cooldown/.test(message)) {
    const reason = message.includes("session_capacity") ? "このセッションには処理中のジョブがあります。"
      : message.includes("submit_cooldown") ? "続けて開始する前に少し待ってください。"
        : "待機中のジョブが上限に達しています。";
    return Response.json({ error: reason }, { status: 429 });
  }
  console.error("Failed to enqueue public job", { code: typeof error === "object" && error && "code" in error ? error.code : "unknown" });
  return Response.json({ error: "ジョブを作成できませんでした。しばらくしてから再試行してください。" }, { status: 502 });
}

export async function submitPublicSelection(request: Request, kind: SelectionContent): Promise<Response> {
  const originDenied = checkWriteOrigin(request);
  if (originDenied) return originDenied;
  const session = await requirePublicSession(request);
  if ("denied" in session) return session.denied;
  let selection;
  let confirmationId: string;
  try {
    const raw = await request.text();
    if (raw.length > 64_000) return Response.json({ error: "取得条件が大きすぎます。" }, { status: 413 });
    const input = JSON.parse(raw) as Record<string, unknown>;
    selection = validateSelection(input);
    if (typeof input.confirmationId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.confirmationId)) {
      throw new SelectionError("取得条件をもう一度確認してください。");
    }
    confirmationId = input.confirmationId;
    if (selection.content !== kind) throw new SelectionError("保存内容を確認してください。");
    if (selection.range === "all") throw new SelectionError("公開版では全件バックアップを利用できません。");
  } catch (error) {
    return Response.json({ error: error instanceof SelectionError ? error.message : "取得条件を確認してください。" }, { status: 400 });
  }
  try {
    const confirmation = await getCatalogQuery(confirmationId, session.id);
    const frozen = confirmedJobRequest(selection, confirmation);
    const row = await enqueuePublicJob(session.id, kind, frozen);
    return Response.json({ job: publicJobView(row) }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SelectionError) return Response.json({ error: error.message }, { status: 409 });
    return submissionError(error);
  }
}

type StatusDependencies = {
  requireSession: typeof requirePublicSession;
  recoverJobs: typeof recoverStaleJobs;
  getOwnedJob: typeof getOwnedPublicJob;
  lastWorkerSeen: typeof workerLastSeen;
};

export async function publicJobStatus(request: Request, id: string, deps: StatusDependencies = {
  requireSession: requirePublicSession, recoverJobs: recoverStaleJobs,
  getOwnedJob: getOwnedPublicJob, lastWorkerSeen: workerLastSeen,
}): Promise<Response> {
  const session = await deps.requireSession(request);
  if ("denied" in session) return session.denied;
  try {
    await deps.recoverJobs();
    const row = await deps.getOwnedJob(id, session.id);
    if (!row) return Response.json({ error: "ジョブが見つかりません。" }, { status: 404 });
    const seen = row.status === "queued" ? await deps.lastWorkerSeen() : null;
    const workerOffline = row.status === "queued" && (!seen || Date.now() - Date.parse(seen) > 45_000);
    return Response.json({ job: publicJobView(row), workerOffline }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "ジョブ保存先に接続できません。管理者に確認してください。" }, { status: 503 }); }
}

type RetryDependencies = {
  requireSession: typeof requirePublicSession;
  getOwnedJob: typeof getOwnedPublicJob;
  enqueueJob: typeof enqueuePublicJob;
};

export async function retryPublicJob(request: Request, id: string, deps: RetryDependencies = {
  requireSession: requirePublicSession, getOwnedJob: getOwnedPublicJob, enqueueJob: enqueuePublicJob,
}): Promise<Response> {
  const originDenied = checkWriteOrigin(request);
  if (originDenied) return originDenied;
  const session = await deps.requireSession(request);
  if ("denied" in session) return session.denied;
  const previous = await deps.getOwnedJob(id, session.id);
  if (!previous || !["partial", "failed"].includes(previous.status)) {
    return Response.json({ error: "再試行できるジョブが見つかりません。" }, { status: 404 });
  }
  const state = previous.state;
  const succeeded = new Set(state.articleResults?.filter((result) => result.status === "succeeded").map((result) => result.id));
  const failed = new Set(state.articleResults?.filter((result) => result.status === "failed").map((result) => result.id));
  const articles = state.requestedArticles?.filter((article) => previous.status === "failed"
    ? !succeeded.has(article.id) : failed.has(article.id));
  const nextRequest = articles?.length && state.requestedAuthor
    ? { retryArticles: articles, author: state.requestedAuthor } : previous.status === "failed" ? previous.request : null;
  if (!nextRequest) return Response.json({ error: "再試行できる記事が見つかりません。" }, { status: 404 });
  try {
    const row = await deps.enqueueJob(session.id, previous.kind, nextRequest, id);
    return Response.json({ job: publicJobView(row) }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return submissionError(error); }
}

type ArtifactDependencies = {
  requireSession: typeof requirePublicSession;
  getOwnedJob: typeof getOwnedPublicJob;
  findArtifact: typeof getArtifact;
  activeSession: typeof isActiveAccessSession;
  signUrl: typeof signedArtifactUrl;
};

export async function publicArtifactRedirect(request: Request, id: string,
  kind: "blog_zip" | "photo_zip" | "photo", articleId?: string, name?: string,
  deps: ArtifactDependencies = {
    requireSession: requirePublicSession, getOwnedJob: getOwnedPublicJob,
    findArtifact: getArtifact, activeSession: isActiveAccessSession, signUrl: signedArtifactUrl,
  }): Promise<Response> {
  const session = await deps.requireSession(request);
  if ("denied" in session) return session.denied;
  const job = await deps.getOwnedJob(id, session.id);
  if (!job || !["succeeded", "partial"].includes(job.status)) {
    return Response.json({ error: "成果物が見つかりません。" }, { status: 404 });
  }
  if (kind === "photo" && (!articleId || !name || !/^[a-z0-9-]+$/.test(articleId)
    || !/^photo-\d{3}\.(jpg|png|webp|gif|avif)$/.test(name))) {
    return Response.json({ error: "写真が見つかりません。" }, { status: 404 });
  }
  const artifact = await deps.findArtifact(id, kind, articleId, name);
  if (!artifact || !(Date.parse(artifact.expires_at) > Date.now())) {
    return Response.json({ error: "成果物の保存期限が切れたか、見つかりません。" }, { status: 404 });
  }
  try {
    if (!await deps.activeSession(session.id)) {
      return Response.json({ error: "アクセスコードを入力してください。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    return Response.json({ error: "ジョブ保存先に接続できません。管理者に確認してください。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const filename = kind === "photo" ? undefined : publicZipFilename(job);
  const url = await deps.signUrl(artifact.object_key, filename);
  return new Response(null, { status: 302, headers: {
    Location: url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  } });
}
