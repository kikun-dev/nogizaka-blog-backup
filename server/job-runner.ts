import type { BlogArticle, BlogAuthor } from "@/lib/catalog/types";
import type { BulkCursor } from "@/lib/selection";
import { localJobStore, type JobStore, type LocalJob } from "./job-store";

export interface JobRunner {
  initialize(): Promise<void>;
  submit(articleUrl: string): Promise<LocalJob | null>;
  submitPhotos(articles: BlogArticle[]): Promise<LocalJob | null>;
  submitBlogs(articles: BlogArticle[], author: BlogAuthor, nextCursor?: BulkCursor): Promise<LocalJob | null>;
  submitFullBackup(author: BlogAuthor, firstUrl: string, cursor?: BulkCursor, priorPartIds?: string[]): Promise<LocalJob | null>;
  continueFullBackup(id: string): Promise<LocalJob | null>;
  resumeFullBackup(id: string): Promise<LocalJob | null>;
}

const MAX_RUNNING = 1;
const MAX_WAITING = 10;
const MAX_BACKUP_ARTICLES = 5000;
const MAX_BACKUP_BYTES = 19 * 1024 * 1024 * 1024;

type FullBackupServices = {
  archiveWebArticles: typeof import("./archive-engine").archiveWebArticles;
  ArchiveOutputLimitError: typeof import("./archive-engine").ArchiveOutputLimitError;
  createStreamingBlogZip: typeof import("./blog-zip").createStreamingBlogZip;
  collectBulkBatch: typeof import("@/lib/selection").collectBulkBatch;
  getArticlePage: typeof import("./catalog").getArticlePage;
};

export class LocalJobRunner implements JobRunner {
  private initialization: Promise<void> | null = null;
  private running = 0;
  private reserved = 0;
  private waiting: LocalJob[] = [];
  private resuming = new Set<string>();
  private continuations = new Map<string, Promise<LocalJob | null>>();

  constructor(
    private readonly store: JobStore,
    private readonly execute: (job: LocalJob) => Promise<void> = (job) => this.run(job),
    private readonly backupOptions?: { services?: FullBackupServices; articleLimit?: number; byteLimit?: number },
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

  async submitFullBackup(author: BlogAuthor, firstUrl: string, cursor: BulkCursor = { page: 1, offset: 0 }, priorPartIds: string[] = []): Promise<LocalJob | null> {
    return this.enqueue(firstUrl, {
      kind: "blog", requestedAuthor: author, fullBackup: true,
      backupPhase: "acquiring", nextCursor: cursor, priorPartIds,
    });
  }

  async continueFullBackup(id: string): Promise<LocalJob | null> {
    const pending = this.continuations.get(id);
    if (pending) return pending;
    const created = this.createContinuation(id);
    this.continuations.set(id, created);
    try { return await created; }
    finally { this.continuations.delete(id); }
  }

  private async createContinuation(id: string): Promise<LocalJob | null> {
    await this.initialize();
    const previous = await this.store.get(id);
    if (!previous?.fullBackup || previous.status !== "succeeded" || !previous.backupStopReason
      || !previous.nextCursor || !previous.requestedAuthor) return null;
    if (previous.continuedByJobId) return this.store.get(previous.continuedByJobId);
    const job = await this.submitFullBackup(previous.requestedAuthor, previous.articleUrl,
      previous.nextCursor, [...(previous.priorPartIds ?? []), previous.id]);
    if (job) await this.store.update(id, { continuedByJobId: job.id });
    return job;
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

  private async enqueue(articleUrl: string, options?: Pick<LocalJob, "kind" | "requestedArticles" | "requestedAuthor" | "nextCursor" | "fullBackup" | "backupPhase" | "priorPartIds">): Promise<LocalJob | null> {
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
    const services = this.backupOptions?.services ?? await (async (): Promise<FullBackupServices> => {
      const [archive, zip, selection, catalog] = await Promise.all([
        import("./archive-engine"), import("./blog-zip"), import("@/lib/selection"), import("./catalog"),
      ]);
      return { archiveWebArticles: archive.archiveWebArticles, ArchiveOutputLimitError: archive.ArchiveOutputLimitError,
        createStreamingBlogZip: zip.createStreamingBlogZip, collectBulkBatch: selection.collectBulkBatch,
        getArticlePage: catalog.getArticlePage };
    })();
    const { archiveWebArticles, ArchiveOutputLimitError, createStreamingBlogZip, collectBulkBatch, getArticlePage } = services;
    const articleLimit = this.backupOptions?.articleLimit ?? MAX_BACKUP_ARTICLES;
    const byteLimit = this.backupOptions?.byteLimit ?? MAX_BACKUP_BYTES;
    let job = (await this.store.get(initial.id)) ?? initial;
    const log = [...job.log].slice(-80);
    const logger = {
      log: (line: string) => { log.push(line); if (log.length > 80) log.shift(); },
      warn: (line: string) => { log.push(line); if (log.length > 80) log.shift(); },
    };
    const loadPage = (page: number) => getArticlePage(author.group, author.id, page);
    while (job.backupPhase !== "packaging") {
      const cursor = job.nextCursor ?? { page: 1, offset: 0 };
      if ((job.savedCount ?? 0) >= articleLimit || (job.outputBytes ?? 0) >= byteLimit) {
        const reason = (job.savedCount ?? 0) >= articleLimit ? "article-limit" : "size-limit";
        let probe = cursor;
        let next: BulkCursor | undefined;
        for (;;) {
          const batch = await collectBulkBatch(loadPage, probe);
          const index = batch.articles.findIndex((article) => !(job.processedArticleIds ?? []).includes(article.id));
          if (index >= 0) { next = batch.positions[index]; break; }
          if (!batch.nextCursor) break;
          probe = batch.nextCursor;
        }
        logger.log(next ? "上限に達したため、ここまでのブログをZIPにまとめます。" : "公式一覧の最後まで取得しました。");
        job = await this.store.update(job.id, { backupPhase: "packaging", nextCursor: next,
          backupStopReason: next ? reason : undefined, log: [...log] });
        break;
      }
      const batch = await collectBulkBatch(
        loadPage, cursor,
        Math.min(10, articleLimit - (job.savedCount ?? 0)),
      );
      if (!batch.articles.length) {
        if (!job.savedCount) throw new Error("保存するブログが見つかりませんでした。");
        job = await this.store.update(job.id, { backupPhase: "packaging", nextCursor: undefined, backupStopReason: undefined });
        break;
      }
      const processed = new Set(job.processedArticleIds ?? []);
      const remaining = batch.articles.filter((article) => !processed.has(article.id));
      let previousBytes = 0;
      if (remaining.length) {
        try {
          await archiveWebArticles({
            articles: remaining, output: job.outputDirectory, author,
            maxBytes: byteLimit - (job.outputBytes ?? 0),
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
        } catch (error) {
          if (!(error instanceof ArchiveOutputLimitError) || !job.savedCount) throw error;
          const index = batch.articles.findIndex((article) => !(job.processedArticleIds ?? []).includes(article.id));
          if (index < 0) throw error;
          logger.log("容量上限に達したため、ここまでのブログをZIPにまとめます。");
          job = await this.store.update(job.id, { backupPhase: "packaging", backupStopReason: "size-limit",
            nextCursor: batch.positions[index], log: [...log] });
          break;
        }
      }
      job = await this.store.update(job.id, {
        nextCursor: batch.nextCursor,
        backupPhase: batch.nextCursor ? "acquiring" : "packaging",
        backupStopReason: undefined,
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
