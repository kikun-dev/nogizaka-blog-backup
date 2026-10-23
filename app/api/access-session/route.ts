import { checkWriteOrigin, isPublicMode, loginWithSharedCode, requirePublicSession } from "@/server/public-access";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isPublicMode()) return Response.json({ enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const result = await requirePublicSession(request);
  if ("denied" in result && result.denied.status === 503) return result.denied;
  return Response.json({ enabled: true, authenticated: "id" in result }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!isPublicMode()) return Response.json({ error: "公開モードではありません。" }, { status: 404 });
  const originDenied = checkWriteOrigin(request);
  if (originDenied) return originDenied;
  const raw = await request.text();
  if (raw.length > 2048) return Response.json({ error: "入力が大きすぎます。" }, { status: 413 });
  let code: unknown;
  try { code = (JSON.parse(raw) as { code?: unknown }).code; }
  catch { return Response.json({ error: "入力を確認してください。" }, { status: 400 }); }
  return loginWithSharedCode(code, request);
}
