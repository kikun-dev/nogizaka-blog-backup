import { NextResponse } from "next/server";
import { localJobStore } from "@/server/job-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await localJobStore.get(id);
  if (!job) return NextResponse.json({ error: "ジョブが見つかりません。" }, { status: 404 });
  return NextResponse.json({ job });
}
