import { getArticlePage, getAuthors, groupSelectionAuthor } from "@/server/catalog";
import { ArticleAuthorError } from "@/server/catalog/adapters";
import { checkLocalAccess } from "@/server/local-access";
import { localJobRunner } from "@/server/job-runner";
import { blogSessionCookie } from "@/server/blog-session";
import { ALL_AUTHORS_ID, SelectionError, collectBulkBatch, collectLatestArticles, validateSelection, verifySelectedArticles } from "@/lib/selection";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  let selection;
  try {
    const raw = await request.text();
    if (raw.length > 64_000) return Response.json({ error: "取得条件が大きすぎます。" }, { status: 413 });
    selection = validateSelection(JSON.parse(raw));
    if (selection.content !== "blog") throw new SelectionError("ブログの保存条件を確認してください。");
  } catch (error) {
    return Response.json({ error: error instanceof SelectionError ? error.message : "取得条件を確認してください。" }, { status: 400 });
  }
  try {
    const author = selection.authorId === ALL_AUTHORS_ID
      ? groupSelectionAuthor(selection.group)
      : (await getAuthors(selection.group)).find(({ id }) => id === selection.authorId);
    if (!author) return Response.json({ error: "公式一覧にないメンバーです。" }, { status: 404 });
    const loadPage = (page: number) => getArticlePage(selection.group, author.id, page);
    const bulk = selection.range === "all" ? await collectBulkBatch(loadPage) : null;
    const articles = bulk?.articles ?? (selection.range === "selected"
      ? await verifySelectedArticles(selection, loadPage)
      : await collectLatestArticles(selection.range === "latest-one" ? 1 : selection.count!, loadPage));
    if (!articles.length) return Response.json({ error: "保存するブログが見つかりませんでした。" }, { status: 404 });
    const job = selection.range === "all"
      ? await localJobRunner.submitFullBackup(author, articles[0].url)
      : await localJobRunner.submitBlogs(articles, author);
    if (!job) return Response.json({ error: "待機中のジョブが上限に達しています。後で再試行してください。" }, { status: 429 });
    return Response.json({ job }, { status: 202, headers: { "Set-Cookie": blogSessionCookie(request), "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SelectionError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof ArticleAuthorError) return Response.json({ error: error.message }, { status: 502 });
    console.error("Failed to start blog job", error);
    return Response.json({ error: "ブログの保存を開始できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
