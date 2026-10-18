import { NextResponse } from "next/server";
import { localJobStore } from "@/server/job-store";
import { localJobRunner } from "@/server/job-runner";
import { checkLocalAccess } from "@/server/local-access";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  await localJobRunner.initialize();
  const { id } = await context.params;
  const job = await localJobStore.get(id);
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  return NextResponse.json({ job });
}
