import { getArticlePage, getAuthors } from "@/server/catalog";
import { checkLocalAccess } from "@/server/local-access";
import { localJobRunner } from "@/server/job-runner";
import { photoSessionCookie } from "@/server/photo-session";
import { SelectionError, collectLatestArticles, validateSelection, verifySelectedArticles } from "@/lib/selection";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  let selection;
  try {
    const raw = await request.text();
    if (raw.length > 64_000) return Response.json({ error: "取得条件が大きすぎます。" }, { status: 413 });
    selection = validateSelection(JSON.parse(raw));
    if (selection.content !== "photos" || selection.range === "all") throw new SelectionError("写真の取得条件を確認してください。");
  } catch (error) {
    return Response.json({ error: error instanceof SelectionError ? error.message : "取得条件を確認してください。" }, { status: 400 });
  }
  try {
    const author = (await getAuthors(selection.group)).find(({ id }) => id === selection.authorId);
    if (!author) return Response.json({ error: "公式一覧にないメンバーです。" }, { status: 404 });
    const loadPage = (page: number) => getArticlePage(selection.group, author.id, page);
    const articles = selection.range === "selected"
      ? await verifySelectedArticles(selection, loadPage)
      : await collectLatestArticles(selection.range === "latest-one" ? 1 : selection.count!, loadPage);
    if (!articles.length) return Response.json({ error: "ブログが見つかりませんでした。" }, { status: 404 });
    const job = await localJobRunner.submitPhotos(articles);
    if (!job) return Response.json({ error: "待機中のジョブが上限に達しています。後で再試行してください。" }, { status: 429 });
    return Response.json({ job }, { status: 202, headers: { "Set-Cookie": photoSessionCookie(request), "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SelectionError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Failed to start photo job", error);
    return Response.json({ error: "写真の取得を開始できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
