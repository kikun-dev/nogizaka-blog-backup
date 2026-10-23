import { blogSessionCookie } from "@/server/blog-session";
import { checkLocalAccess } from "@/server/local-access";
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
  if (previous.status !== "succeeded" || !previous.backupStopReason || !previous.nextCursor) {
    return Response.json({ error: "続きから開始できるバックアップではありません。" }, { status: 409 });
  }
  const job = await localJobRunner.continueFullBackup(id);
  if (!job) return Response.json({ error: "待機中のジョブが上限に達しています。後で再試行してください。" }, { status: 429 });
  return Response.json({ job }, { status: job.status === "queued" ? 202 : 200,
    headers: { "Set-Cookie": blogSessionCookie(request), "Cache-Control": "no-store" } });
}
