import { setTimeout as delay } from "node:timers/promises";
import { requirePublicSession } from "./public-access";
import { enqueueCatalogQuery, getCatalogQuery, isActiveAccessSession, workerLastSeen, type CatalogQueryRequest, type CatalogQueryRow } from "./public-store";

export function catalogErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (/session_expired/.test(message)) {
    return Response.json({ error: "アクセスコードを入力してください。" }, {
      status: 401, headers: { "Cache-Control": "no-store" },
    });
  }
  if (/catalog_.*capacity/.test(message)) {
    return Response.json({ error: "一覧取得が混み合っています。少し待って再試行してください。" }, { status: 429 });
  }
  return Response.json({ error: "一覧取得の保存先に接続できません。管理者に確認してください。" }, { status: 503 });
}

export async function terminalCatalogResponse(current: CatalogQueryRow | null, sessionId: string,
  query: CatalogQueryRequest, hasActiveSession = isActiveAccessSession): Promise<Response | null> {
  if (!current || (current.status !== "succeeded" && current.status !== "failed")) return null;
  if (!await hasActiveSession(sessionId)) return catalogErrorResponse(new Error("session_expired"));
  if (current.status === "succeeded" && current.result) {
    return Response.json(query.kind === "selection"
      ? { ...current.result, confirmationId: current.id } : current.result,
    { headers: { "Cache-Control": "no-store" } });
  }
  if (current.status === "failed") {
    return Response.json({ error: current.error ?? "公式一覧を取得できませんでした。" }, { status: 502 });
  }
  return null;
}

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
      const terminalResponse = await terminalCatalogResponse(current, session.id, query);
      if (terminalResponse) return terminalResponse;
      await delay(500);
    }
    return Response.json({ error: "一覧取得を待っています。少し待って再試行してください。" }, { status: 503 });
  } catch (error) {
    return catalogErrorResponse(error);
  }
}
