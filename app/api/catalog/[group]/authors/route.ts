import { getAuthors } from "@/server/catalog";
import { isBlogGroup } from "@/server/catalog/adapters";
import { checkLocalAccess } from "@/server/local-access";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ group: string }> }) {
  const denied = checkLocalAccess(request);
  if (denied) return denied;
  const { group } = await params;
  if (!isBlogGroup(group)) return Response.json({ error: "対象外のグループです。" }, { status: 404 });
  try {
    return Response.json({ authors: await getAuthors(group) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to load blog authors", error);
    return Response.json({ error: "公式サイトのメンバー一覧を取得できませんでした。少し待って再試行してください。" }, { status: 502 });
  }
}
