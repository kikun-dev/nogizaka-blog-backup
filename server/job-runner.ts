import type { BlogArticle, BlogAuthor } from "@/lib/catalog/types";
import type { BulkCursor } from "@/lib/selection";
import { localJobStore, type JobStore, type LocalJob } from "./job-store";

export interface JobRunner {
  initialize(): Promise<void>;
  submit(articleUrl: string): Promise<LocalJob | null>;
  submitPhotos(articles: BlogArticle[]): Promise<LocalJob | null>;
  submitBlogs(articles: BlogArticle[], author: BlogAuthor, nextCursor?: BulkCursor): Promise<LocalJob | null>;
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
    return this.enqueue(articleUrl, { kind: "blog" });
  }

  async submitPhotos(articles: BlogArticle[]): Promise<LocalJob | null> {
    if (!articles.length) throw new Error("取得対象のブログがありません。");
    return this.enqueue(articles[0].url, { kind: "photos", requestedArticles: articles });
  }

  async submitBlogs(articles: BlogArticle[], author: BlogAuthor, nextCursor?: BulkCursor): Promise<LocalJob | null> {
    if (!articles.length || articles.length > 10) throw new Error("ブログは1回10件まで保存できます。");
    return this.enqueue(articles[0].url, { kind: "blog", requestedArticles: articles, requestedAuthor: author, nextCursor });
  }

  private async enqueue(articleUrl: string, options?: Pick<LocalJob, "kind" | "requestedArticles" | "requestedAuthor" | "nextCursor">): Promise<LocalJob | null> {
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
      const [{ archiveWebArticles }, { createBlogZip }] = await Promise.all([
        import("./archive-engine"), import("./blog-zip"),
      ]);
      const log: string[] = [];
      const result = await archiveWebArticles({
        articles: job.requestedArticles ?? [{ url: job.articleUrl }],
        output: job.outputDirectory,
        author: job.requestedAuthor,
      }, {
        logger: { log: (line: string) => { log.push(line); }, warn: (line: string) => { log.push(line); } },
        onProgress: async (count: number, bytes: number) => {
          await this.store.update(job.id, { savedCount: count, outputBytes: bytes, log: log.slice(-80) });
        },
      });
      await createBlogZip(job.outputDirectory, result.saved.map(({ directory }) => directory));
      await this.store.update(job.id, {
        status: "succeeded", savedCount: result.saved.length, outputBytes: result.totalBytes,
        blogZipReady: true, log: log.slice(-80),
      });
    } catch (error) {
      await this.store.update(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "予期しないエラーが発生しました。",
      }).catch(() => {});
    }
  }
}

export const localJobRunner: JobRunner = new LocalJobRunner(localJobStore);
