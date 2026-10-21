import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { checkBlogSession } from "@/server/blog-session";
import { isPublicMode } from "@/server/public-access";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isPublicMode()) return (await import("@/server/public-api")).publicArtifactRedirect(request, (await context.params).id, "blog_zip");
  const denied = checkBlogSession(request);
  if (denied) return denied;
  const { localJobStore } = await import("@/server/job-store");
  const { id } = await context.params;
  const job = await localJobStore.get(id);
  if (job?.kind !== "blog" || !["succeeded", "partial"].includes(job.status) || !job.blogZipReady) {
    return Response.json({ error: "ZIPが見つかりません。" }, { status: 404 });
  }
  try {
    const file = path.join(job.outputDirectory, "blogs.zip");
    const info = await stat(file);
    const groups: Record<string, string> = { nogizaka: "Nogizaka", sakurazaka: "Sakurazaka", hinatazaka: "Hinatazaka" };
    const groupName = groups[job.requestedAuthor?.group ?? ""] ?? "Sakamichi";
    const authorName = (job.requestedAuthor?.name ?? "Blog").normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60);
    const date = job.createdAt.slice(0, 10).replaceAll("-", "");
    const filename = `${groupName}_${authorName}_${date}_${id.slice(0, 8)}.zip`;
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/zip", "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="sakamichi-blogs-${id}.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      },
    });
  } catch { return Response.json({ error: "ZIPが見つかりません。" }, { status: 404 }); }
}
