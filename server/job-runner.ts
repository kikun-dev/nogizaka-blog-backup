import type { BlogArticle, BlogAuthor } from "@/lib/catalog/types";
import type { BulkCursor } from "@/lib/selection";
import { localJobStore, type JobStore, type LocalJob } from "./job-store";

export interface JobRunner {
  initialize(): Promise<void>;
  submit(articleUrl: string): Promise<LocalJob | null>;
  submitPhotos(articles: BlogArticle[]): Promise<LocalJob | null>;
  submitBlogs(articles: BlogArticle[], author: BlogAuthor, nextCursor?: BulkCursor): Promise<LocalJob | null>;
  submitFullBackup(author: BlogAuthor, firstUrl: string): Promise<LocalJob | null>;
  resumeFullBackup(id: string): Promise<LocalJob | null>;
}

const MAX_RUNNING = 1;
const MAX_WAITING = 10;
const MAX_BACKUP_ARTICLES = 5000;
const MAX_BACKUP_BYTES = 19 * 1024 * 1024 * 1024;

export class LocalJobRunner implements JobRunner {
  private initialization: Promise<void> | null = null;
  private running = 0;
  private reserved = 0;
  private waiting: LocalJob[] = [];
  private resuming = new Set<string>();

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

  async submitFullBackup(author: BlogAuthor, firstUrl: string): Promise<LocalJob | null> {
    return this.enqueue(firstUrl, {
      kind: "blog", requestedAuthor: author, fullBackup: true,
      backupPhase: "acquiring", nextCursor: { page: 1, offset: 0 },
    });
  }

  async resumeFullBackup(id: string): Promise<LocalJob | null> {
    await this.initialize();
    if (this.resuming.has(id) || this.running + this.waiting.length + this.reserved >= MAX_RUNNING + MAX_WAITING) return null;
    this.resuming.add(id);
    this.reserved++;
    try {
      const job = await this.store.get(id);
      if (!job?.fullBackup || job.status !== "failed") return null;
      const resumed = await this.store.update(id, { status: "queued", error: undefined });
      this.waiting.push(resumed);
      return resumed;
    } finally {
      this.resuming.delete(id);
      this.reserved--;
      this.pump();
    }
  }

  private async enqueue(articleUrl: string, options?: Pick<LocalJob, "kind" | "requestedArticles" | "requestedAuthor" | "nextCursor" | "fullBackup" | "backupPhase">): Promise<LocalJob | null> {
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
      await this.store.update(job.id, { status: "running", error: undefined });
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
      if (job.fullBackup) {
        await this.runFullBackup(job);
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
        blogZipReady: true, log: log.slice(-80), error: undefined,
      });
    } catch (error) {
      await this.store.update(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "予期しないエラーが発生しました。",
      }).catch(() => {});
    }
  }

  private async runFullBackup(initial: LocalJob) {
    const author = initial.requestedAuthor;
    if (!author) throw new Error("全件バックアップのメンバー情報がありません。");
    const [{ archiveWebArticles }, { createStreamingBlogZip }, { collectBulkBatch }, { getArticlePage }] = await Promise.all([
      import("./archive-engine"), import("./blog-zip"), import("@/lib/selection"), import("./catalog"),
    ]);
    let job = (await this.store.get(initial.id)) ?? initial;
    const log = [...job.log].slice(-80);
    const logger = {
      log: (line: string) => { log.push(line); if (log.length > 80) log.shift(); },
      warn: (line: string) => { log.push(line); if (log.length > 80) log.shift(); },
    };
    while (job.backupPhase !== "packaging") {
      const cursor = job.nextCursor ?? { page: 1, offset: 0 };
      if ((job.savedCount ?? 0) >= MAX_BACKUP_ARTICLES) {
        const extra = await collectBulkBatch((page) => getArticlePage(author.group, author.id, page), cursor, 1);
        if (extra.articles.length) throw new Error(`全件バックアップは最大${MAX_BACKUP_ARTICLES}件です。`);
        job = await this.store.update(job.id, { backupPhase: "packaging", nextCursor: undefined });
        break;
      }
      const batch = await collectBulkBatch(
        (page) => getArticlePage(author.group, author.id, page), cursor,
        Math.min(10, MAX_BACKUP_ARTICLES - (job.savedCount ?? 0)),
      );
      if (!batch.articles.length) {
        if (!job.savedCount) throw new Error("保存するブログが見つかりませんでした。");
        job = await this.store.update(job.id, { backupPhase: "packaging", nextCursor: undefined });
        break;
      }
      const processed = new Set(job.processedArticleIds ?? []);
      const remaining = batch.articles.filter((article) => !processed.has(article.id));
      let previousBytes = 0;
      if (remaining.length) {
        await archiveWebArticles({
          articles: remaining, output: job.outputDirectory, author,
          maxBytes: MAX_BACKUP_BYTES - (job.outputBytes ?? 0),
          cacheResults: false,
        }, {
          logger,
          onProgress: async (_count: number, bytes: number, saved: { directory: string; metadata: { id: string } }) => {
            job = await this.store.update(job.id, {
              savedCount: (job.savedCount ?? 0) + 1,
              outputBytes: (job.outputBytes ?? 0) + bytes - previousBytes,
              savedDirectories: [...(job.savedDirectories ?? []), saved.directory],
              processedArticleIds: [...(job.processedArticleIds ?? []), saved.metadata.id],
              log: [...log],
            });
            previousBytes = bytes;
          },
        });
      }
      job = await this.store.update(job.id, {
        nextCursor: batch.nextCursor,
        backupPhase: batch.nextCursor ? "acquiring" : "packaging",
        log: [...log],
      });
    }
    if (!job.savedDirectories?.length) throw new Error("保存済みのブログが見つかりませんでした。");
    logger.log(`取得した${job.savedCount}件を1つのZIPにまとめています。`);
    job = await this.store.update(job.id, { backupPhase: "packaging", log: [...log] });
    await createStreamingBlogZip(job.outputDirectory, job.savedDirectories ?? []);
    await this.store.update(job.id, { status: "succeeded", blogZipReady: true, log: [...log], error: undefined });
  }
}

const runnerGlobal = globalThis as typeof globalThis & { sakamichiLocalJobRunner?: JobRunner };
export const localJobRunner: JobRunner = runnerGlobal.sakamichiLocalJobRunner ??= new LocalJobRunner(localJobStore);
