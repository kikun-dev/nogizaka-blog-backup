import { getArticlePage, getAuthors } from "@/server/catalog";
import { checkLocalAccess } from "@/server/local-access";
import { SELECTION_LIMITS, SelectionError, collectBulkBatch, collectLatestArticles, validateSelection, verifySelectedArticles } from "@/lib/selection";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;

  let selection;
  try {
    const raw = await request.text();
    if (raw.length > 64_000) return Response.json({ error: "取得条件が大きすぎます。" }, { status: 413 });
    selection = validateSelection(JSON.parse(raw));
  } catch (error) {
    return Response.json({ error: error instanceof SelectionError ? error.message : "取得条件を確認してください。" }, { status: 400 });
  }

  try {
    const author = (await getAuthors(selection.group)).find(({ id }) => id === selection.authorId);
    if (!author) return Response.json({ error: "公式一覧にないメンバーです。" }, { status: 404 });
    const loadPage = (page: number) => getArticlePage(selection.group, author.id, page);
    const previewArticles = selection.range === "selected"
      ? await verifySelectedArticles(selection, loadPage)
      : selection.range === "latest-one" || selection.range === "latest-n"
        ? await collectLatestArticles(selection.range === "latest-one" ? 1 : selection.count!, loadPage)
        : (await collectBulkBatch(loadPage, selection.cursor)).articles;
    if (previewArticles.length === 0) {
      return Response.json({ error: "ブログが見つかりませんでした。" }, { status: 404 });
    }
    return Response.json({
      plan: { ...selection, author, maxArticles: SELECTION_LIMITS[selection.content], firstArticle: previewArticles[0], previewArticles },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SelectionError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Failed to verify article selection", error);
    return Response.json({ error: "公式サイトの一覧を確認できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
