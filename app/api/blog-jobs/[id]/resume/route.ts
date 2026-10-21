import { checkLocalAccess } from "@/server/local-access";
import { blogSessionCookie } from "@/server/blog-session";
import { isPublicMode } from "@/server/public-access";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isPublicMode()) return Response.json({ error: "公開版では全件バックアップを利用できません。" }, { status: 404 });
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  const [{ localJobRunner }, { localJobStore }] = await Promise.all([
    import("@/server/job-runner"), import("@/server/job-store"),
  ]);
  const { id } = await context.params;
  const previous = await localJobStore.get(id);
  if (!previous?.fullBackup) return Response.json({ error: "全件バックアップが見つかりません。" }, { status: 404 });
  if (previous.status !== "failed") return Response.json({ job: previous }, { headers: { "Set-Cookie": blogSessionCookie(request), "Cache-Control": "no-store" } });
  const job = await localJobRunner.resumeFullBackup(id);
  if (!job) {
    const current = await localJobStore.get(id);
    if (current && current.status !== "failed") {
      return Response.json({ job: current }, { headers: { "Set-Cookie": blogSessionCookie(request), "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "再開できませんでした。待機中のジョブが上限の可能性があります。" }, { status: 429 });
  }
  return Response.json({ job }, { status: 202, headers: { "Set-Cookie": blogSessionCookie(request), "Cache-Control": "no-store" } });
}
