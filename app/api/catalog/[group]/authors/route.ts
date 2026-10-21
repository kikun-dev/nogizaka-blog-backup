import { isBlogGroup } from "@/server/catalog/adapters";
import { checkLocalAccess } from "@/server/local-access";
import { isPublicMode, requirePublicSession } from "@/server/public-access";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ group: string }> }) {
  const session = isPublicMode() ? await requirePublicSession(request) : null;
  const denied = session && "denied" in session ? session.denied : !session ? checkLocalAccess(request) : null;
  if (denied) return denied;
  const { group } = await params;
  if (!isBlogGroup(group)) return Response.json({ error: "対象外のグループです。" }, { status: 404 });
  if (isPublicMode()) return (await import("@/server/public-catalog-api")).publicCatalogResponse(request, { kind: "authors", group });
  try {
    const { getAuthors } = await import("@/server/catalog");
    return Response.json({ authors: await getAuthors(group) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to load blog authors", error);
    return Response.json({ error: "公式サイトのメンバー一覧を取得できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
