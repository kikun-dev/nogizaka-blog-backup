import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { checkPhotoSession } from "@/server/photo-session";
import { isPublicMode } from "@/server/public-access";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isPublicMode()) return (await import("@/server/public-api")).publicArtifactRedirect(request, (await context.params).id, "photo_zip");
  const denied = checkPhotoSession(request);
  if (denied) return denied;
  const { localJobStore } = await import("@/server/job-store");
  const { id } = await context.params;
  const job = await localJobStore.get(id);
  if (job?.kind !== "photos" || !job.photoZipReady) return Response.json({ error: "ZIPが見つかりません。" }, { status: 404 });
  try {
    const file = path.join(job.outputDirectory, "photos.zip");
    const info = await stat(file);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
      headers: { "Content-Type": "application/zip", "Content-Length": String(info.size), "Content-Disposition": `attachment; filename="sakamichi-photos-${id}.zip"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch { return Response.json({ error: "ZIPが見つかりません。" }, { status: 404 }); }
}
