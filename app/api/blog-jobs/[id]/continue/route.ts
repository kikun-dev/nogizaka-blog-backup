import { blogSessionCookie } from "@/server/blog-session";
import { localJobRunner } from "@/server/job-runner";
import { localJobStore } from "@/server/job-store";
import { checkLocalAccess } from "@/server/local-access";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;
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
