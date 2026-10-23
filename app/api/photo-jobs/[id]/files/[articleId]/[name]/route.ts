import { readFile } from "node:fs/promises";
import path from "node:path";
import { checkPhotoSession } from "@/server/photo-session";
import { isPublicMode } from "@/server/public-access";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string; articleId: string; name: string }> }) {
  if (isPublicMode()) {
    const { id, articleId, name } = await context.params;
    return (await import("@/server/public-api")).publicArtifactRedirect(request, id, "photo", articleId, name);
  }
  const denied = checkPhotoSession(request);
  if (denied) return denied;
  const { localJobStore } = await import("@/server/job-store");
  const { id, articleId, name } = await context.params;
  const job = await localJobStore.get(id);
  const photo = job?.kind === "photos" && job.photoArticles?.find((article) => article.id === articleId)?.photos.find((item) => item.name === name);
  if (!photo || !/^[a-z0-9-]+$/.test(articleId) || !/^photo-\d{3}\.(jpg|png|webp|gif|avif)$/.test(name)) {
    return Response.json({ error: "写真が見つかりません。" }, { status: 404 });
  }
  try {
    const bytes = await readFile(path.join(job!.outputDirectory, "photos", articleId, name));
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": photo.mimeType, "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch { return Response.json({ error: "写真が見つかりません。" }, { status: 404 }); }
}
