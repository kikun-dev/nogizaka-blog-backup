import { getArticlePage } from "@/server/catalog";
import { isAuthorId, isBlogGroup } from "@/server/catalog/adapters";
import { checkLocalAccess } from "@/server/local-access";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ group: string; authorId: string }> }) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  const { group, authorId } = await params;
  if (!isBlogGroup(group) || !isAuthorId(authorId)) {
    return Response.json({ error: "対象外のメンバーです。" }, { status: 404 });
  }
  const requestedPage = new URL(request.url).searchParams.get("page") ?? "1";
  const page = Number(requestedPage);
  if (!/^\d+$/.test(requestedPage) || !Number.isSafeInteger(page) || page < 1 || page > 10000) {
    return Response.json({ error: "ページ番号が正しくありません。" }, { status: 400 });
  }
  try {
    const articles = await getArticlePage(group, authorId, page);
    if (!articles) return Response.json({ error: "公式一覧にないメンバーです。" }, { status: 404 });
    return Response.json({ articles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to load blog articles", error);
    return Response.json({ error: "公式サイトのブログ一覧を取得できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
