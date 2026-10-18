export type ArchiveOptions = {
  url: string;
  output: string;
  limit?: number;
  delay?: number;
  headed?: boolean;
  force?: boolean;
};

export type ArticleInfo = {
  id: string;
  articleUrl: string;
  title: string;
  authorName: string;
  date: string;
  previousUrl: string | null;
  images: { detected: number; loaded: number; failed: number };
  groupKey: string;
  groupName: string;
};

export type ArchiveLogger = Pick<Console, "log" | "warn">;

export function inspectArticle(
  options: { url: string; headed?: boolean },
  dependencies?: { logger?: ArchiveLogger },
): Promise<ArticleInfo>;

export function archiveArticles(
  options: ArchiveOptions,
  dependencies?: { logger?: ArchiveLogger },
): Promise<{ processed: number; directory: string | null }>;

export function normalizeArticleUrl(url: string, baseUrl?: string, expectedGroupKey?: string): string;
export function sameAuthor(left: string, right: string): boolean;
