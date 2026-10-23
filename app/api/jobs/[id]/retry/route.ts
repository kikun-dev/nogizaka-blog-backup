import { checkLocalAccess } from "@/server/local-access";
import { blogSessionCookie } from "@/server/blog-session";
import { photoSessionCookie } from "@/server/photo-session";
import { isPublicMode } from "@/server/public-access";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isPublicMode()) return (await import("@/server/public-api")).retryPublicJob(request, (await context.params).id);
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  const [{ localJobRunner }, { localJobStore }] = await Promise.all([
    import("@/server/job-runner"), import("@/server/job-store"),
  ]);
  const { id } = await context.params;
  const previous = await localJobStore.get(id);
  if (!previous || previous.fullBackup || !previous.articleResults?.some((article) => article.status === "failed")) {
    return Response.json({ error: "再試行できる記事が見つかりません。" }, { status: 404 });
  }
  const job = await localJobRunner.retryFailed(id);
  if (!job) return Response.json({ error: "再試行を開始できませんでした。待機中のジョブが上限の可能性があります。" }, { status: 429 });
  return Response.json({ job }, { status: 202, headers: {
    "Set-Cookie": previous.kind === "photos" ? photoSessionCookie(request) : blogSessionCookie(request),
    "Cache-Control": "no-store",
  } });
}
