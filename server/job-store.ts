import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlogArticle, BlogAuthor } from "@/lib/catalog/types";
import type { BulkCursor } from "@/lib/selection";

export type SavedPhoto = { name: string; mimeType: string };
export type PhotoArticle = {
  id: string;
  title: string;
  date: string;
  authorName: string;
  photos: SavedPhoto[];
  detected: number;
  failed: number;
  error?: string;
};

export type JobStatus = "queued" | "running" | "succeeded" | "partial" | "failed";
export type ArticleResult = { id: string; title: string; date: string; status: "succeeded" | "failed"; message?: string };

export type LocalJob = {
  id: string;
  articleUrl: string;
  kind?: "blog" | "photos";
  requestedArticles?: BlogArticle[];
  requestedAuthor?: BlogAuthor;
  nextCursor?: BulkCursor;
  fullBackup?: boolean;
  backupPhase?: "acquiring" | "packaging";
  backupStopReason?: "article-limit" | "size-limit";
  priorPartIds?: string[];
  continuedByJobId?: string;
  processedArticleIds?: string[];
  savedDirectories?: string[];
  blogZipReady?: boolean;
  savedCount?: number;
  outputBytes?: number;
  photoArticles?: PhotoArticle[];
  photoZipReady?: boolean;
  articleResults?: ArticleResult[];
  currentArticle?: { title: string; date: string };
  retryOfJobId?: string;
  retriedByJobId?: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  outputDirectory: string;
  log: string[];
  error?: string;
};

export interface JobStore {
  create(articleUrl: string, options?: Pick<LocalJob, "kind" | "requestedArticles" | "requestedAuthor" | "nextCursor" | "fullBackup" | "backupPhase" | "priorPartIds" | "retryOfJobId">): Promise<LocalJob>;
  get(id: string): Promise<LocalJob | null>;
  update(id: string, change: Partial<LocalJob>): Promise<LocalJob>;
  failInterrupted(): Promise<void>;
}

const root = path.join(process.cwd(), ".local-data");
const jobDirectory = path.join(root, "jobs");
const archiveDirectory = path.resolve(process.cwd(), process.env.LOCAL_ARCHIVE_ROOT ?? ".local-data/archive");

function jobPath(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return path.join(jobDirectory, `${id}.json`);
}

async function save(job: LocalJob) {
  const destination = jobPath(job.id);
  if (!destination) throw new Error("Invalid job ID");
  await mkdir(jobDirectory, { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  await writeFile(temporary, JSON.stringify(job, null, 2));
  await rename(temporary, destination);
}

export const localJobStore: JobStore = {
  async create(articleUrl, options) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: LocalJob = {
      id,
      articleUrl,
      ...options,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      outputDirectory: path.join(archiveDirectory, id),
      log: [],
    };
    await save(job);
    return job;
  },
  async get(id) {
    const destination = jobPath(id);
    if (!destination) return null;
    try {
      const job = JSON.parse(await readFile(destination, "utf8")) as LocalJob;
      if (job.status === "succeeded" || job.status === "partial") delete job.error;
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async update(id, change) {
    const current = await this.get(id);
    if (!current) throw new Error("Job not found");
    if ((current.status === "succeeded" || current.status === "partial") && change.status === "failed") return current;
    const updated: LocalJob = {
      ...current,
      ...change,
      id: current.id,
      updatedAt: new Date().toISOString(),
    };
    if (updated.status === "succeeded" || updated.status === "partial") delete updated.error;
    await save(updated);
    return updated;
  },
  async failInterrupted() {
    let names: string[];
    try {
      names = await readdir(jobDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const job = await this.get(id);
      if (job?.status === "queued" || job?.status === "running") {
        await this.update(id, {
          status: "failed",
          error: "サーバーが再起動したため処理を中断しました。もう一度開始してください。",
        });
      }
    }
  },
};
