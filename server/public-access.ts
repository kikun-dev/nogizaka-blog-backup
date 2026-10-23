import { createHash, createHmac } from "node:crypto";
import { authenticateAccessCode, findAccessSession } from "./public-store";

const COOKIE = "sakamichi_session";
// The database controls access: it starts at 24 hours and can be extended while
// a job runs and until its artifacts expire. Keep the cookie long enough for
// that server-side extension to remain usable after the original login day.
const COOKIE_SECONDS = 7 * 24 * 60 * 60;

export function isPublicMode(): boolean {
  // A missing APP_MODE on a Vercel deployment must never fall back to the
  // in-process local runner.
  return process.env.APP_MODE === "public" || process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
}

export async function loginWithAccessCode(code: unknown, request: Request): Promise<Response> {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret || typeof code !== "string" || code.length > 2048) {
    return Response.json({ error: "アクセスコードを確認してください。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const forwarded = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for");
  const clientAddress = forwarded?.split(",")[0]?.trim() || "unknown";
  const rateKey = createHmac("sha256", secret).update(clientAddress).digest("hex");
  let session;
  try {
    session = await authenticateAccessCode(createHash("sha256").update(code).digest("hex"), rateKey);
  } catch {
    return Response.json({ error: "ジョブ保存先に接続できません。管理者に確認してください。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!session) return Response.json({ error: "アクセスコードを確認してください。" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return Response.json({ ok: true }, {
    headers: {
      "Set-Cookie": `${COOKIE}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_SECONDS}${secure}`,
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
