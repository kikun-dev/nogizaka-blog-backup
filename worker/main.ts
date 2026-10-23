import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalJobRunner } from "../server/job-runner";
import { executeCatalogQuery } from "../server/public-catalog-worker";
import type { JobStore, LocalJob } from "../server/job-store";
import {
  claimPublicJob, completePublicJob, heartbeatPublicJob, progressPublicJob, cleanupPublicData,
  claimCatalogQuery, heartbeatCatalogQuery, completeCatalogQuery,
  type ArtifactInput, type PublicJobRow, type CatalogQueryRow,
} from "../server/public-store";
import { deleteArtifact, uploadArtifact } from "../server/public-r2";
import { errorDiagnostic } from "./diagnostics";
import { pollOnce } from "./poll";
import { finishUploadedArtifacts } from "./artifact-lifecycle";
import { resolvePublicJob } from "./resolve-job";
import { cleanOrphanWork, prepareWork } from "./workspace";

const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const workerId = randomUUID();
let stopping = false;

class LeaseLostError extends Error {}

function safeState(job: LocalJob): Partial<LocalJob> {
  const state: Partial<LocalJob> = { ...job };
  delete state.outputDirectory;
  return state;
}

async function uploadResults(job: LocalJob, generation: number, artifacts: ArtifactInput[]): Promise<void> {
  const prefix = `${job.id}/${generation}`;
  let photoBytes = 0;
  if (job.kind === "photos") {
    for (const article of job.photoArticles ?? []) {
      for (const photo of article.photos) {
        const file = path.join(job.outputDirectory, "photos", article.id, photo.name);
        const size = (await stat(file)).size;
        photoBytes += size;
        if (photoBytes > MAX_OUTPUT_BYTES) throw new Error("写真の合計サイズが512 MBを超えました。");
        artifacts.push(await uploadArtifact(file, {
          kind: "photo", article_id: article.id, name: photo.name,
          object_key: `${prefix}/photos/${article.id}/${photo.name}`, mime_type: photo.mimeType,
        }));
      }
    }
    if (job.photoZipReady) {
      const file = path.join(job.outputDirectory, "photos.zip");
      if ((await stat(file)).size > MAX_OUTPUT_BYTES) throw new Error("写真ZIPが512 MBを超えました。");
      artifacts.push(await uploadArtifact(file, { kind: "photo_zip", object_key: `${prefix}/photos.zip`, mime_type: "application/zip" }));
    }
  } else if (job.blogZipReady) {
    const file = path.join(job.outputDirectory, "blogs.zip");
    if ((await stat(file)).size > MAX_OUTPUT_BYTES) throw new Error("ブログZIPが512 MBを超えました。");
    artifacts.push(await uploadArtifact(file, { kind: "blog_zip", object_key: `${prefix}/blogs.zip`, mime_type: "application/zip" }));
  }
}

async function runClaimed(row: PublicJobRow): Promise<void> {
  const generation = row.lease_generation;
  let outputDirectory: string | undefined;
  const uploaded: ArtifactInput[] = [];
  let lostLease = false;
  let localJob: LocalJob | undefined;
  const heartbeat = setInterval(() => {
    void heartbeatPublicJob(row.id, workerId, generation).then((ok) => {
      if (!ok) lostLease = true;
    }).catch(() => { lostLease = true; });
  }, 15_000);
  heartbeat.unref();
  try {
    outputDirectory = await prepareWork();
    localJob = await resolvePublicJob(row, outputDirectory);
    const initialProgress = await progressPublicJob(row.id, workerId, generation, safeState(localJob), localJob.requestedAuthor);
    if (!initialProgress) throw new LeaseLostError();
    const store: JobStore = {
      create: async () => { throw new Error("公開ワーカーからジョブは作成できません。"); },
      get: async () => localJob ?? null,
      update: async (_id, change) => {
        if (lostLease) throw new LeaseLostError();
        localJob = { ...localJob!, ...change, updatedAt: new Date().toISOString() };
        const ok = await progressPublicJob(row.id, workerId, generation, safeState(localJob), localJob.requestedAuthor);
        if (!ok) { lostLease = true; throw new LeaseLostError(); }
        return localJob;
      },
      failInterrupted: async () => {},
    };
    await new LocalJobRunner(store, undefined, { photoByteLimit: 500 * 1024 * 1024, cacheResults: false }).executeOne(localJob);
    if (lostLease || !(await heartbeatPublicJob(row.id, workerId, generation))) throw new LeaseLostError();
    if (localJob.status === "succeeded" || localJob.status === "partial") {
      await uploadResults(localJob, generation, uploaded);
    }
    if (lostLease || !(await heartbeatPublicJob(row.id, workerId, generation))) throw new LeaseLostError();
    const status = ["succeeded", "partial"].includes(localJob.status) ? localJob.status as "succeeded" | "partial" : "failed";
    const completedJob = localJob;
    const committed = await finishUploadedArtifacts(
      () => completePublicJob(row.id, workerId, generation, status, safeState(completedJob), completedJob.error ?? null, uploaded),
      uploaded);
    if (!committed) throw new LeaseLostError();
  } catch (error) {
    if (!(error instanceof LeaseLostError) && !lostLease) {
      const detail = error instanceof Error ? error.message : "";
      const message = /^(ワーカーの空き容量|写真の|ブログZIP|取得する記事|公式一覧|公開版|再試行する記事)/.test(detail)
        ? detail : "ワーカーが処理を完了できませんでした。再試行してください。";
      await completePublicJob(row.id, workerId, generation, "failed", localJob ? safeState(localJob) : {}, message, [])
        .catch((commitError: unknown) => {
          console.error("Failed to record public job failure", { jobId: row.id, ...errorDiagnostic(commitError) });
        });
      console.error("Public job failed", { jobId: row.id, ...errorDiagnostic(error) });
    }
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled(uploaded.map((artifact) => deleteArtifact(artifact.object_key)));
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function runCatalog(row: CatalogQueryRow): Promise<void> {
  const generation = row.lease_generation;
  let lostLease = false;
  const heartbeat = setInterval(() => {
    void heartbeatCatalogQuery(row.id, workerId, generation).then((ok) => {
      if (!ok) lostLease = true;
    }).catch(() => { lostLease = true; });
  }, 15_000);
  heartbeat.unref();
  try {
    const result = await executeCatalogQuery(row.request);
    if (lostLease) return;
    await completeCatalogQuery(row.id, workerId, generation, result, null);
  } catch (error) {
    if (!lostLease) {
      const message = error instanceof Error && /^(公式|対象外|記事一覧|ブログ|公開版)/.test(error.message)
        ? error.message : "公式一覧を取得できませんでした。少し待って再試行してください。";
      await completeCatalogQuery(row.id, workerId, generation, null, message)
        .catch((commitError: unknown) => {
          console.error("Failed to record catalog query failure", { queryId: row.id, ...errorDiagnostic(commitError) });
        });
      console.error("Catalog query failed", { queryId: row.id, ...errorDiagnostic(error) });
    }
  } finally { clearInterval(heartbeat); }
}

async function jobLoop(): Promise<void> {
  let nextCleanupAt = 0;
  while (!stopping) {
    try {
      if (Date.now() >= nextCleanupAt) {
        nextCleanupAt = Date.now() + 60 * 60_000;
        try { await cleanupPublicData(); }
        catch (error) { console.error("Public data cleanup failed", errorDiagnostic(error)); }
      }
      const handled = await pollOnce(() => claimPublicJob(workerId), runClaimed);
      if (!handled) await delay(5_000);
    } catch (error) {
      console.error("Worker polling failed", errorDiagnostic(error));
      await delay(10_000);
    }
  }
}

async function catalogLoop(): Promise<void> {
  while (!stopping) {
    try {
      const handled = await pollOnce(() => claimCatalogQuery(workerId), runCatalog);
      if (!handled) await delay(1_000);
    } catch (error) {
      console.error("Catalog polling failed", errorDiagnostic(error));
      await delay(10_000);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.APP_MODE !== "public") throw new Error("APP_MODE=public を設定してください。");
  await cleanOrphanWork();
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  await Promise.all([jobLoop(), catalogLoop()]);
}

await main();
