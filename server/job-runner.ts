import { spawn } from "node:child_process";
import path from "node:path";
import type { BlogArticle } from "@/lib/catalog/types";
import { localJobStore, type JobStore, type LocalJob } from "./job-store";

export interface JobRunner {
  initialize(): Promise<void>;
  submit(articleUrl: string): Promise<LocalJob | null>;
  submitPhotos(articles: BlogArticle[]): Promise<LocalJob | null>;
}

const MAX_RUNNING = 1;
const MAX_WAITING = 10;

export class LocalJobRunner implements JobRunner {
  private initialization: Promise<void> | null = null;
  private running = 0;
  private reserved = 0;
  private waiting: LocalJob[] = [];

  constructor(
    private readonly store: JobStore,
    private readonly execute: (job: LocalJob) => Promise<void> = (job) => this.run(job),
  ) {}

  async initialize() {
    if (!this.initialization) {
      this.initialization = this.store.failInterrupted().catch((error: unknown) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
  }

  async submit(articleUrl: string): Promise<LocalJob | null> {
    return this.enqueue(articleUrl);
  }

  async submitPhotos(articles: BlogArticle[]): Promise<LocalJob | null> {
    if (!articles.length) throw new Error("取得対象のブログがありません。");
    return this.enqueue(articles[0].url, { kind: "photos", requestedArticles: articles });
  }

  private async enqueue(articleUrl: string, options?: Pick<LocalJob, "kind" | "requestedArticles">): Promise<LocalJob | null> {
    await this.initialize();
    if (this.running + this.waiting.length + this.reserved >= MAX_RUNNING + MAX_WAITING) return null;
    this.reserved++;
    try {
      const job = await this.store.create(articleUrl, options);
      this.waiting.push(job);
      return job;
    } finally {
      this.reserved--;
      this.pump();
    }
  }

  private pump() {
    while (this.running < MAX_RUNNING && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: LocalJob) {
    try {
      await this.store.update(job.id, { status: "running" });
      if (job.kind === "photos") {
        const [{ acquirePhotos }, { createPhotoZip }] = await Promise.all([
          import("./photo-acquisition"), import("./photo-zip"),
        ]);
        const photoArticles = await acquirePhotos(job.requestedArticles ?? [], job.outputDirectory);
        let photoZipReady = false;
        try { photoZipReady = await createPhotoZip(job.outputDirectory, photoArticles); }
        catch (error) { console.error("Failed to create photo ZIP", error); }
        const hasUsableArticle = photoArticles.some((article) => !article.error && (article.detected === 0 || article.photos.length > 0));
        await this.store.update(job.id, {
          photoArticles,
          photoZipReady,
          status: hasUsableArticle ? "succeeded" : "failed",
          ...(!hasUsableArticle ? { error: "写真を取得できませんでした。各ブログの結果を確認してください。" } : {}),
        });
        return;
      }
      const script = path.join(process.cwd(), "archive-sakamichi-blog.mjs");
      const child = spawn(process.execPath, [
        script,
        "--url", job.articleUrl,
        "--output", job.outputDirectory,
        "--limit", "1",
      ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });

      let pending = Promise.resolve();
      let transcript = "";
      const append = (chunk: Buffer) => {
        transcript += chunk.toString("utf8");
        const lines = transcript.split(/\r?\n/);
        transcript = lines.pop() ?? "";
        if (!lines.length) return;
        pending = pending.then(async () => {
          const current = await this.store.get(job.id);
          if (current) {
            await this.store.update(job.id, {
              log: [...current.log, ...lines].slice(-80),
            });
          }
        });
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code) => resolve({ code }));
      });
      if (transcript) {
        const lastLine = transcript;
        pending = pending.then(async () => {
          const current = await this.store.get(job.id);
          if (current) {
            await this.store.update(job.id, {
              log: [...current.log, lastLine].slice(-80),
            });
          }
        });
      }
      await pending;
      await this.store.update(job.id, result.code === 0
        ? { status: "succeeded" }
        : { status: "failed", error: result.error?.message ?? "取得処理が完了しませんでした。" });
    } catch (error) {
      await this.store.update(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "予期しないエラーが発生しました。",
      }).catch(() => {});
    }
  }
}

export const localJobRunner: JobRunner = new LocalJobRunner(localJobStore);
