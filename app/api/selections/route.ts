import { ArticleAuthorError } from "@/server/catalog/adapters";
import { checkLocalAccess } from "@/server/local-access";
import { isPublicMode, requirePublicSession } from "@/server/public-access";
import { ALL_AUTHORS_ID, SELECTION_LIMITS, SelectionError, collectBulkBatch, collectLatestArticles, validateSelection, verifySelectedArticles } from "@/lib/selection";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = isPublicMode() ? await requirePublicSession(request) : null;
  const denied = session && "denied" in session ? session.denied : !session ? checkLocalAccess(request) : null;
  if (denied) return denied;

  let selection;
  try {
    const raw = await request.text();
    if (raw.length > 64_000) return Response.json({ error: "取得条件が大きすぎます。" }, { status: 413 });
    selection = validateSelection(JSON.parse(raw));
    if (isPublicMode() && selection.range === "all") {
      return Response.json({ error: "公開版では全件バックアップを利用できません。" }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error instanceof SelectionError ? error.message : "取得条件を確認してください。" }, { status: 400 });
  }

  if (isPublicMode()) return (await import("@/server/public-catalog-api")).publicCatalogResponse(request,
    { kind: "selection", selection });
  try {
    const { getArticlePage, getAuthors, groupSelectionAuthor } = await import("@/server/catalog");
    const author = selection.authorId === ALL_AUTHORS_ID
      ? groupSelectionAuthor(selection.group)
      : (await getAuthors(selection.group)).find(({ id }) => id === selection.authorId);
    if (!author) return Response.json({ error: "公式一覧にないメンバーです。" }, { status: 404 });
    const loadPage = (page: number) => getArticlePage(selection.group, author.id, page);
    const previewArticles = selection.range === "selected"
      ? await verifySelectedArticles(selection, loadPage)
      : selection.range === "latest-one" || selection.range === "latest-n"
        ? await collectLatestArticles(selection.range === "latest-one" ? 1 : selection.count!, loadPage)
        : (await collectBulkBatch(loadPage)).articles;
    if (previewArticles.length === 0) {
      return Response.json({ error: "ブログが見つかりませんでした。" }, { status: 404 });
    }
    return Response.json({
      plan: { ...selection, author, maxArticles: SELECTION_LIMITS[selection.content], firstArticle: previewArticles[0], previewArticles },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SelectionError) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof ArticleAuthorError) return Response.json({ error: error.message }, { status: 502 });
    console.error("Failed to verify article selection", error);
    return Response.json({ error: "公式サイトの一覧を確認できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
