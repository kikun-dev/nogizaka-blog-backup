import { NextResponse } from "next/server";
import { parseArticleUrl } from "@/server/article-url";
import { checkLocalAccess } from "@/server/local-access";
import { blogSessionCookie } from "@/server/blog-session";
import { isPublicMode } from "@/server/public-access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (isPublicMode()) return NextResponse.json({ error: "公開版では取得条件からブログを選んでください。" }, { status: 404 });
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  const { localJobRunner } = await import("@/server/job-runner");

  let articleUrl: string;
  try {
    const body: unknown = await request.json();
    articleUrl = parseArticleUrl((body as { url?: unknown })?.url);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "入力を確認してください。" }, { status: 400 });
  }

  const job = await localJobRunner.submit(articleUrl);
  if (!job) return NextResponse.json({ error: "待機中のジョブが上限に達しています。後で再試行してください。" }, { status: 429 });
  return NextResponse.json({ job }, { status: 202, headers: { "Set-Cookie": blogSessionCookie(request), "Cache-Control": "no-store" } });
}
