import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "blog_access";
const LIFETIME_SECONDS = 24 * 60 * 60;

function signature(expiry: string, secret: string) {
  return createHmac("sha256", secret).update(`blog-access:${expiry}`).digest("hex");
}

export function blogSessionCookie(request: Request) {
  const secret = process.env.LOCAL_ACCESS_TOKEN;
  if (!secret) throw new Error("LOCAL_ACCESS_TOKEN が設定されていません。");
  const expiry = String(Math.floor(Date.now() / 1000) + LIFETIME_SECONDS);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${expiry}.${signature(expiry, secret)}; HttpOnly; SameSite=Strict; Path=/api/blog-jobs/; Max-Age=${LIFETIME_SECONDS}${secure}`;
}

export function checkBlogSession(request: Request): Response | null {
  const secret = process.env.LOCAL_ACCESS_TOKEN;
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const match = value?.match(/^(\d{10})\.([0-9a-f]{64})$/);
  if (!secret || !match || Number(match[1]) < Date.now() / 1000) {
    return Response.json({ error: "ZIPの閲覧期限が切れました。取得条件から再度開始してください。" }, { status: 401 });
  }
  const actual = Buffer.from(match[2], "hex");
  const expected = Buffer.from(signature(match[1], secret), "hex");
  if (!timingSafeEqual(actual, expected)) return Response.json({ error: "ZIPへのアクセスを確認してください。" }, { status: 401 });
  return null;
}
