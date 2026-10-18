import { createHash, timingSafeEqual } from "node:crypto";

export function checkLocalAccess(request: Request): Response | null {
  const configured = process.env.LOCAL_ACCESS_TOKEN;
  if (!configured) {
    return Response.json({ error: "LOCAL_ACCESS_TOKEN が設定されていません。" }, { status: 503 });
  }

  const supplied = request.headers.get("authorization");
  const token = supplied?.startsWith("Bearer ") ? supplied.slice(7) : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!token || !timingSafeEqual(digest(token), digest(configured))) {
    return Response.json({ error: "アクセストークンを確認してください。" }, {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  return null;
}
