import type { BlogArticle, BlogAuthor } from "@/lib/catalog/types";
import { SelectionError, type BulkCursor } from "@/lib/selection";
import { normalizeArticleUrl } from "../lib/archive/urls.mjs";
import { localJobStore, type ArticleResult, type JobStore, type LocalJob } from "./job-store";

export interface JobRunner {
  initialize(): Promise<void>;
  submit(articleUrl: string): Promise<LocalJob | null>;
  submitPhotos(articles: BlogArticle[]): Promise<LocalJob | null>;
  submitBlogs(articles: BlogArticle[], author: BlogAuthor, nextCursor?: BulkCursor): Promise<LocalJob | null>;
  submitFullBackup(author: BlogAuthor, firstUrl: string, cursor?: BulkCursor, priorPartIds?: string[]): Promise<LocalJob | null>;
  continueFullBackup(id: string): Promise<LocalJob | null>;
  resumeFullBackup(id: string): Promise<LocalJob | null>;
  retryFailed(id: string): Promise<LocalJob | null>;
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
type JobServices = {
  archiveWebArticles: typeof import("./archive-engine").archiveWebArticles;
  createBlogZip: typeof import("./blog-zip").createBlogZip;
  acquirePhotos: typeof import("./photo-acquisition").acquirePhotos;
  createPhotoZip: typeof import("./photo-zip").createPhotoZip;
};

export class LocalJobRunner implements JobRunner {
  private initialization: Promise<void> | null = null;
  private running = 0;
  private reserved = 0;
  private waiting: LocalJob[] = [];
  private resuming = new Set<string>();
  private continuations = new Map<string, Promise<LocalJob | null>>();
  private retries = new Map<string, Promise<LocalJob | null>>();
  private submissions = new Map<string, Promise<LocalJob | null>>();
  private activeKeys = new Map<string, string>();

  constructor(
    private readonly store: JobStore,
    private readonly execute: (job: LocalJob) => Promise<void> = (job) => this.run(job),
    private readonly backupOptions?: { services?: FullBackupServices; jobServices?: JobServices; articleLimit?: number; byteLimit?: number },
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

  async retryFailed(id: string): Promise<LocalJob | null> {
    const pending = this.retries.get(id);
    if (pending) return pending;
    const promise = this.createRetry(id);
    this.retries.set(id, promise);
    try { return await promise; }
    finally { this.retries.delete(id); }
  }

  private async createRetry(id: string): Promise<LocalJob | null> {
    await this.initialize();
    const previous = await this.store.get(id);
    if (!previous || previous.fullBackup || !["partial", "failed"].includes(previous.status)) return null;
    if (previous.retriedByJobId) return this.store.get(previous.retriedByJobId);
    const failed = new Set(previous.articleResults?.filter((article) => article.status === "failed").map((article) => article.id));
    const articles = previous.requestedArticles?.filter((article) => failed.has(article.id));
    if (articles && !articles.length) return null;
    const retry = await this.enqueue(articles?.[0]?.url ?? previous.articleUrl, {
      kind: previous.kind, requestedArticles: articles, requestedAuthor: previous.requestedAuthor,
      retryOfJobId: id,
    });
    if (retry) await this.store.update(id, { retriedByJobId: retry.id });
    return retry;
  }

  private async enqueue(articleUrl: string, options?: Pick<LocalJob, "kind" | "requestedArticles" | "requestedAuthor" | "nextCursor" | "fullBackup" | "backupPhase" | "priorPartIds" | "retryOfJobId">): Promise<LocalJob | null> {
    const articleIdentities = options?.requestedArticles?.map((article) => [
      article.author.group, article.author.id,
      normalizeArticleUrl(article.url, undefined, article.author.group),
    ]) ?? [[options?.requestedAuthor?.group, options?.requestedAuthor?.id,
      normalizeArticleUrl(articleUrl, undefined, options?.requestedAuthor?.group)]];
    const key = JSON.stringify([options?.kind, articleIdentities,
      options?.fullBackup, options?.nextCursor, options?.priorPartIds, options?.retryOfJobId]);
    const pending = this.submissions.get(key);
    if (pending) return pending;
    const promise = this.createQueuedJob(articleUrl, options, key);
    this.submissions.set(key, promise);
    try { return await promise; }
    finally { this.submissions.delete(key); }
  }

  private async createQueuedJob(articleUrl: string, options: Parameters<JobStore["create"]>[1], key: string): Promise<LocalJob | null> {
    await this.initialize();
    const activeId = this.activeKeys.get(key);
    if (activeId) return this.store.get(activeId);
    if (this.running + this.waiting.length + this.reserved >= MAX_RUNNING + MAX_WAITING) return null;
    this.reserved++;
    try {
      const job = await this.store.create(articleUrl, options);
      this.activeKeys.set(key, job.id);
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
        for (const [key, id] of this.activeKeys) if (id === job.id) this.activeKeys.delete(key);
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: LocalJob) {
    try {
      await this.store.update(job.id, { status: "running", error: undefined });
      if (job.fullBackup) {
        await this.runFullBackup(job);
        return;
      }
      const services = this.backupOptions?.jobServices ?? await (async (): Promise<JobServices> => {
        const [archive, blogZip, photos, photoZip] = await Promise.all([
          import("./archive-engine"), import("./blog-zip"), import("./photo-acquisition"), import("./photo-zip"),
        ]);
        return { archiveWebArticles: archive.archiveWebArticles, createBlogZip: blogZip.createBlogZip,
          acquirePhotos: photos.acquirePhotos, createPhotoZip: photoZip.createPhotoZip };
      })();
      if (job.kind === "photos") {
        const { acquirePhotos, createPhotoZip } = services;
        const photoArticles = await acquirePhotos(job.requestedArticles ?? [], job.outputDirectory, async (results, current) => {
          const articleResults: ArticleResult[] = results.map((article) => ({
            id: article.id, title: article.title, date: article.date,
            status: article.error || article.failed > 0 ? "failed" : "succeeded",
            ...(article.error || article.failed > 0 ? { message: "写真の一部または全部を取得できませんでした。" } : {}),
          }));
          await this.store.update(job.id, { photoArticles: results, articleResults,
            savedCount: articleResults.filter((article) => article.status === "succeeded").length,
            currentArticle: current ? { title: current.title, date: current.date } : undefined });
        });
        let photoZipReady = false;
        try { photoZipReady = await createPhotoZip(job.outputDirectory, photoArticles); }
        catch (error) { console.error("Failed to create photo ZIP", error); }
        const successCount = photoArticles.filter((article) => !article.error && article.failed === 0).length;
        const failureCount = photoArticles.length - successCount;
        await this.store.update(job.id, {
          photoArticles,
          photoZipReady,
          savedCount: successCount,
          currentArticle: undefined,
          status: failureCount ? successCount || photoArticles.some((article) => article.photos.length > 0) ? "partial" : "failed" : "succeeded",
          ...(failureCount === photoArticles.length ? { error: "写真を取得できませんでした。各ブログの結果を確認してください。" } : {}),
        });
        return;
      }
      const { archiveWebArticles, createBlogZip } = services;
      const log: string[] = [];
      const articleResults: ArticleResult[] = [];
      const result = await archiveWebArticles({
        articles: job.requestedArticles ?? [{ url: job.articleUrl }],
        output: job.outputDirectory,
        author: job.requestedAuthor,
      }, {
        logger: { log: (line: string) => { log.push(line); }, warn: (line: string) => { log.push(line); } },
        continueOnError: true,
        onStart: async (article) => {
          await this.store.update(job.id, { currentArticle: { title: article.title ?? "ブログ", date: article.date ?? "" } });
        },
        onFailure: async (article, error) => {
          console.error("Failed to save blog article", { jobId: job.id, articleId: article.id, error });
          articleResults.push({ id: article.id ?? article.url, title: article.title ?? "ブログ", date: article.date ?? "",
            status: "failed", message: "このブログを保存できませんでした。" });
          await this.store.update(job.id, { articleResults: [...articleResults], currentArticle: undefined, log: log.slice(-80) });
        },
        onProgress: async (count: number, bytes: number, saved) => {
          articleResults.push({ id: saved.metadata.id, title: saved.metadata.title, date: saved.metadata.date, status: "succeeded" });
          await this.store.update(job.id, { savedCount: count, outputBytes: bytes, articleResults: [...articleResults],
            currentArticle: undefined, log: log.slice(-80) });
        },
      });
      if (result.saved.length) await createBlogZip(job.outputDirectory, result.saved.map(({ directory }) => directory));
      await this.store.update(job.id, {
        status: articleResults.some((article) => article.status === "failed")
          ? result.saved.length ? "partial" : "failed" : "succeeded",
        savedCount: result.saved.length, outputBytes: result.totalBytes,
        blogZipReady: result.saved.length > 0, currentArticle: undefined,
        articleResults, log: log.slice(-80),
        ...(result.saved.length ? { error: undefined } : { error: "ブログを保存できませんでした。失敗した記事を再試行できます。" }),
      });
    } catch (error) {
      console.error("Job failed", { jobId: job.id, error });
      await this.store.update(job.id, {
        status: "failed",
        currentArticle: undefined,
        error: error instanceof SelectionError ? error.message : "処理を完了できませんでした。しばらくしてから再試行してください。",
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
    const processed = new Set(job.processedArticleIds ?? []);
    for (const id of job.priorPartIds ?? []) {
      const prior = await this.store.get(id);
      if (!prior || prior.status !== "succeeded") throw new Error("前のパートの保存情報を確認できませんでした。");
      for (const articleId of prior.processedArticleIds ?? []) processed.add(articleId);
    }
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
          const batch = await collectBulkBatch(loadPage, probe, 10, processed);
          if (batch.articles.length) {
            next = { ...batch.positions[0], afterArticleId: job.processedArticleIds?.at(-1) ?? probe.afterArticleId };
            break;
          }
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
        processed,
      );
      if (!batch.articles.length) {
        if (!job.savedCount) throw new Error("保存するブログが見つかりませんでした。");
        job = await this.store.update(job.id, { backupPhase: "packaging", nextCursor: undefined, backupStopReason: undefined });
        break;
      }
      const remaining = batch.articles;
      let previousBytes = 0;
      if (remaining.length) {
        try {
          await archiveWebArticles({
            articles: remaining, output: job.outputDirectory, author,
            maxBytes: byteLimit - (job.outputBytes ?? 0),
            cacheResults: false,
          }, {
            logger,
            onStart: async (article) => {
              job = await this.store.update(job.id, { currentArticle: { title: article.title ?? "ブログ", date: article.date ?? "" } });
            },
            onProgress: async (_count: number, bytes: number, saved: { directory: string; metadata: { id: string } }) => {
              job = await this.store.update(job.id, {
                savedCount: (job.savedCount ?? 0) + 1,
                outputBytes: (job.outputBytes ?? 0) + bytes - previousBytes,
                savedDirectories: [...(job.savedDirectories ?? []), saved.directory],
                processedArticleIds: [...(job.processedArticleIds ?? []), saved.metadata.id],
                currentArticle: undefined,
                log: [...log],
              });
              processed.add(saved.metadata.id);
              previousBytes = bytes;
            },
          });
        } catch (error) {
          if (!(error instanceof ArchiveOutputLimitError) || !job.savedCount) throw error;
          const index = batch.articles.findIndex((article) => !processed.has(article.id));
          if (index < 0) throw error;
          logger.log("容量上限に達したため、ここまでのブログをZIPにまとめます。");
          job = await this.store.update(job.id, { backupPhase: "packaging", backupStopReason: "size-limit",
            nextCursor: { ...batch.positions[index], afterArticleId: job.processedArticleIds?.at(-1) ?? cursor.afterArticleId }, log: [...log] });
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
    await this.store.update(job.id, { status: "succeeded", blogZipReady: true, currentArticle: undefined, log: [...log], error: undefined });
  }
}

// Keep a runner across development module reloads, but replace one created by an
// older implementation so new progress callbacks are actually used.
const RUNNER_VERSION = 2;
const runnerGlobal = globalThis as typeof globalThis & {
  sakamichiLocalJobRunner?: JobRunner;
  sakamichiLocalJobRunnerVersion?: number;
};
if (!runnerGlobal.sakamichiLocalJobRunner || runnerGlobal.sakamichiLocalJobRunnerVersion !== RUNNER_VERSION) {
  runnerGlobal.sakamichiLocalJobRunner = new LocalJobRunner(localJobStore);
  runnerGlobal.sakamichiLocalJobRunnerVersion = RUNNER_VERSION;
}
export const localJobRunner: JobRunner = runnerGlobal.sakamichiLocalJobRunner;
