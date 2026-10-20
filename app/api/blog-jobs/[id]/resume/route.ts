import { checkLocalAccess } from "@/server/local-access";
import { blogSessionCookie } from "@/server/blog-session";
import { localJobRunner } from "@/server/job-runner";
import { localJobStore } from "@/server/job-store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  const { id } = await context.params;
  const previous = await localJobStore.get(id);
  if (!previous?.fullBackup) return Response.json({ error: "全件バックアップが見つかりません。" }, { status: 404 });
  if (previous.status !== "failed") return Response.json({ error: "このジョブは再開できません。" }, { status: 409 });
  const job = await localJobRunner.resumeFullBackup(id);
  if (!job) return Response.json({ error: "再開できませんでした。待機中のジョブが上限の可能性があります。" }, { status: 429 });
  return Response.json({ job }, { status: 202, headers: { "Set-Cookie": blogSessionCookie(request), "Cache-Control": "no-store" } });
}
