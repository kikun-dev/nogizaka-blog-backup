import { createHash, timingSafeEqual } from "node:crypto";
import { createAccessSession, findAccessSession } from "./public-store";

const COOKIE = "sakamichi_session";
const SESSION_SECONDS = 24 * 60 * 60;

export function isPublicMode(): boolean {
  // A missing APP_MODE on a Vercel deployment must never fall back to the
  // in-process local runner.
  return process.env.APP_MODE === "public" || process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

export function verifySharedCode(supplied: unknown): boolean {
  const configured = process.env.SHARED_ACCESS_CODE;
  if (!configured || configured.length < 16 || typeof supplied !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(configured), digest(supplied));
}

export async function loginWithSharedCode(code: unknown, request: Request): Promise<Response> {
  if (!process.env.SHARED_ACCESS_CODE || process.env.SHARED_ACCESS_CODE.length < 16) {
    return Response.json({ error: "公開用アクセスコードの設定がありません。" }, { status: 503 });
  }
  if (!verifySharedCode(code)) {
    return Response.json({ error: "アクセスコードを確認してください。" }, { status: 401 });
  }
  let session;
  try { session = await createAccessSession(); }
  catch {
    return Response.json({ error: "ジョブ保存先に接続できません。管理者に確認してください。" }, { status: 503 });
  }
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return Response.json({ ok: true }, {
    headers: {
      "Set-Cookie": `${COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function publicSessionId(request: Request): Promise<string | null> {
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token ? findAccessSession(token) : null;
}

export async function requirePublicSession(request: Request): Promise<{ id: string } | { denied: Response }> {
  let id: string | null;
  try { id = await publicSessionId(request); }
  catch { return { denied: Response.json({ error: "ジョブ保存先に接続できません。管理者に確認してください。" }, { status: 503 }) }; }
  if (!id) return { denied: Response.json({ error: "アクセスコードを入力してください。" }, { status: 401, headers: { "Cache-Control": "no-store" } }) };
  return { id };
}

export function checkWriteOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "送信元を確認してください。" }, { status: 403 });
  }
  return null;
}
