import { NextResponse } from "next/server";
import { parseArticleUrl } from "@/server/article-url";
import { localJobStore } from "@/server/job-store";
import { localJobRunner } from "@/server/job-runner";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let articleUrl: string;
  try {
    const body: unknown = await request.json();
    articleUrl = parseArticleUrl((body as { url?: unknown })?.url);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "入力を確認してください。" }, { status: 400 });
  }

  const job = await localJobStore.create(articleUrl);
  localJobRunner.start(job);
  return NextResponse.json({ job }, { status: 202 });
}
