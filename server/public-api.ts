import { validateSelection, SelectionError, type SelectionContent } from "@/lib/selection";
import { checkWriteOrigin, requirePublicSession } from "./public-access";
import { enqueuePublicJob, getArtifact, getOwnedPublicJob, publicJobView, recoverStaleJobs, workerLastSeen } from "./public-store";
import { signedArtifactUrl } from "./public-r2";
import { publicZipFilename } from "./public-download-name";

function submissionError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "ジョブを作成できませんでした。";
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
  try {
    const raw = await request.text();
    if (raw.length > 64_000) return Response.json({ error: "取得条件が大きすぎます。" }, { status: 413 });
    selection = validateSelection(JSON.parse(raw));
    if (selection.content !== kind) throw new SelectionError("保存内容を確認してください。");
    if (selection.range === "all") throw new SelectionError("公開版では全件バックアップを利用できません。");
  } catch (error) {
    return Response.json({ error: error instanceof SelectionError ? error.message : "取得条件を確認してください。" }, { status: 400 });
  }
  try {
    const row = await enqueuePublicJob(session.id, kind, { selection });
    return Response.json({ job: publicJobView(row) }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return submissionError(error); }
}

export async function publicJobStatus(request: Request, id: string): Promise<Response> {
  const session = await requirePublicSession(request);
  if ("denied" in session) return session.denied;
  try {
    await recoverStaleJobs();
    const row = await getOwnedPublicJob(id, session.id);
    if (!row) return Response.json({ error: "ジョブが見つかりません。" }, { status: 404 });
    const seen = row.status === "queued" ? await workerLastSeen() : null;
    const workerOffline = row.status === "queued" && (!seen || Date.now() - Date.parse(seen) > 45_000);
    return Response.json({ job: publicJobView(row), workerOffline }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "ジョブ保存先に接続できません。管理者に確認してください。" }, { status: 503 }); }
}

export async function retryPublicJob(request: Request, id: string): Promise<Response> {
  const originDenied = checkWriteOrigin(request);
  if (originDenied) return originDenied;
  const session = await requirePublicSession(request);
  if ("denied" in session) return session.denied;
  const previous = await getOwnedPublicJob(id, session.id);
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
    const row = await enqueuePublicJob(session.id, previous.kind, nextRequest, id);
    return Response.json({ job: publicJobView(row) }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return submissionError(error); }
}

export async function publicArtifactRedirect(request: Request, id: string,
  kind: "blog_zip" | "photo_zip" | "photo", articleId?: string, name?: string): Promise<Response> {
  const session = await requirePublicSession(request);
  if ("denied" in session) return session.denied;
  const job = await getOwnedPublicJob(id, session.id);
  if (!job || !["succeeded", "partial"].includes(job.status)) {
    return Response.json({ error: "成果物が見つかりません。" }, { status: 404 });
  }
  if (kind === "photo" && (!articleId || !name || !/^[a-z0-9-]+$/.test(articleId)
    || !/^photo-\d{3}\.(jpg|png|webp|gif|avif)$/.test(name))) {
    return Response.json({ error: "写真が見つかりません。" }, { status: 404 });
  }
  const artifact = await getArtifact(id, kind, articleId, name);
  if (!artifact) return Response.json({ error: "成果物の保存期限が切れたか、見つかりません。" }, { status: 404 });
  const filename = kind === "photo" ? undefined : publicZipFilename(job);
  const url = await signedArtifactUrl(artifact.object_key, filename);
  return new Response(null, { status: 302, headers: {
    Location: url, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  } });
}
