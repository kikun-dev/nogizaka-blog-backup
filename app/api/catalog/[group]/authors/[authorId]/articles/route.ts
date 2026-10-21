import { ALL_AUTHORS_ID } from "@/lib/selection";
import { ArticleAuthorError, isAuthorId, isBlogGroup } from "@/server/catalog/adapters";
import { checkLocalAccess } from "@/server/local-access";
import { isPublicMode, requirePublicSession } from "@/server/public-access";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ group: string; authorId: string }> }) {
  const session = isPublicMode() ? await requirePublicSession(request) : null;
  const denied = session && "denied" in session ? session.denied : !session ? checkLocalAccess(request) : null;
  if (denied) return denied;
  const { group, authorId } = await params;
  if (!isBlogGroup(group) || (authorId !== ALL_AUTHORS_ID && !isAuthorId(authorId))) {
    return Response.json({ error: "対象外のメンバーです。" }, { status: 404 });
  }
  const requestedPage = new URL(request.url).searchParams.get("page") ?? "1";
  const page = Number(requestedPage);
  if (!/^\d+$/.test(requestedPage) || !Number.isSafeInteger(page) || page < 1 || page > 10000) {
    return Response.json({ error: "ページ番号が正しくありません。" }, { status: 400 });
  }
  if (isPublicMode()) return (await import("@/server/public-catalog-api")).publicCatalogResponse(request,
    { kind: "articles", group, authorId, page });
  try {
    const { getArticlePage } = await import("@/server/catalog");
    const articles = await getArticlePage(group, authorId, page);
    if (!articles) return Response.json({ error: "公式一覧にないメンバーです。" }, { status: 404 });
    return Response.json({ articles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ArticleAuthorError) return Response.json({ error: error.message }, { status: 502 });
    console.error("Failed to load blog articles", error);
    return Response.json({ error: "公式サイトのブログ一覧を取得できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
