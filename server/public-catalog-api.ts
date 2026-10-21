import { setTimeout as delay } from "node:timers/promises";
import { requirePublicSession } from "./public-access";
import { enqueueCatalogQuery, getCatalogQuery, workerLastSeen, type CatalogQueryRequest } from "./public-store";

export async function publicCatalogResponse(request: Request, query: CatalogQueryRequest): Promise<Response> {
  const session = await requirePublicSession(request);
  if ("denied" in session) return session.denied;
  try {
    const seen = await workerLastSeen();
    if (!seen || Date.now() - Date.parse(seen) > 45_000) {
      return Response.json({ error: "一覧取得ワーカーが停止中です。起動後に再試行してください。" }, { status: 503 });
    }
    const queued = await enqueueCatalogQuery(session.id, query);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const current = await getCatalogQuery(queued.id, session.id);
      if (current?.status === "succeeded" && current.result) {
        return Response.json(current.result, { headers: { "Cache-Control": "no-store" } });
      }
      if (current?.status === "failed") {
        return Response.json({ error: current.error ?? "公式一覧を取得できませんでした。" }, { status: 502 });
      }
      await delay(500);
    }
    return Response.json({ error: "一覧取得を待っています。少し待って再試行してください。" }, { status: 503 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/catalog_.*capacity/.test(message)) {
      return Response.json({ error: "一覧取得が混み合っています。少し待って再試行してください。" }, { status: 429 });
    }
    return Response.json({ error: "一覧取得の保存先に接続できません。管理者に確認してください。" }, { status: 503 });
  }
}
