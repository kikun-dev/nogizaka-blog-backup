import { normalizeArticleUrl } from "./archive/urls.mjs";
import type { BlogArticle, BlogArticlePage, BlogAuthor, BlogGroup } from "./catalog/types";

export type SelectionContent = "photos" | "blog";
export type SelectionRange = "latest-one" | "latest-n" | "selected" | "all";
export type SelectedArticle = { url: string; sourcePage: number };
export type BulkCursor = { page: number; offset: number };

export type SelectionRequest = {
  group: BlogGroup;
  authorId: string;
  content: SelectionContent;
  range: SelectionRange;
  count?: number;
  articles?: SelectedArticle[];
};

export type SelectionPlan = SelectionRequest & {
  author: BlogAuthor;
  maxArticles: number;
  firstArticle?: BlogArticle;
  previewArticles?: BlogArticle[];
};

export const SELECTION_LIMITS: Readonly<Record<SelectionContent, number>> = {
  photos: 20,
  blog: 10,
};

export class SelectionError extends Error {}

export function validateSelection(input: unknown): SelectionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SelectionError("取得条件を確認してください。");
  }
  const value = input as Record<string, unknown>;
  if (value.group !== "nogizaka" && value.group !== "sakurazaka" && value.group !== "hinatazaka") {
    throw new SelectionError("グループを選択してください。");
  }
  if (typeof value.authorId !== "string" || !/^\d{1,8}$/.test(value.authorId)) {
    throw new SelectionError("メンバーを選択してください。");
  }
  if (value.content !== "photos" && value.content !== "blog") {
    throw new SelectionError("保存内容を選択してください。");
  }
  if (value.range !== "latest-one" && value.range !== "latest-n" && value.range !== "selected" && value.range !== "all") {
    throw new SelectionError("取得範囲を選択してください。");
  }

  const selection: SelectionRequest = {
    group: value.group,
    authorId: value.authorId,
    content: value.content,
    range: value.range,
  };
  const limit = SELECTION_LIMITS[value.content];

  if (value.range === "latest-n") {
    if (!Number.isInteger(value.count) || (value.count as number) < 2 || (value.count as number) > limit) {
      throw new SelectionError(`最新ブログの件数は2〜${limit}件で指定してください。`);
    }
    selection.count = value.count as number;
  } else if (value.count !== undefined) {
    throw new SelectionError("ブログの件数指定が取得範囲と一致しません。");
  }

  if (value.range === "selected") {
    if (!Array.isArray(value.articles) || value.articles.length === 0 || value.articles.length > limit) {
      throw new SelectionError(`選べるブログは最大${limit}件です。`);
    }
    const articles = value.articles.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SelectionError("ブログを確認してください。");
      const { url, sourcePage } = entry as Record<string, unknown>;
      if (typeof url !== "string" || url.length > 2048) throw new SelectionError("ブログのURLを確認してください。");
      if (!Number.isSafeInteger(sourcePage) || (sourcePage as number) < 1 || (sourcePage as number) > 10000) {
        throw new SelectionError("ブログ一覧のページ番号を確認してください。");
      }
      try { return { url: normalizeArticleUrl(url, undefined, selection.group), sourcePage: sourcePage as number }; }
      catch { throw new SelectionError("選択したブログに別グループのURLが含まれています。"); }
    });
    if (new Set(articles.map(({ url }) => new URL(url).pathname)).size !== articles.length) {
      throw new SelectionError("同じブログを重複して選択できません。");
    }
    selection.articles = articles;
  } else if (value.articles !== undefined) {
    throw new SelectionError("ブログの指定が取得範囲と一致しません。");
  }

  if (value.range === "all" && value.content !== "blog") {
    throw new SelectionError("全件バックアップはブログ保存で選択してください。");
  }
  if (value.cursor !== undefined) throw new SelectionError("全件バックアップの続きは元のジョブから再開してください。");

  return selection;
}

export async function collectBulkBatch(
  loadPage: (page: number) => Promise<BlogArticlePage | null>,
  cursor: BulkCursor = { page: 1, offset: 0 },
  limit = SELECTION_LIMITS.blog,
): Promise<{ articles: BlogArticle[]; positions: BulkCursor[]; nextCursor?: BulkCursor }> {
  const articles: BlogArticle[] = [];
  const positions: BulkCursor[] = [];
  let { page, offset } = cursor;
  while (articles.length < limit && page <= 10000) {
    const listing = await loadPage(page);
    if (!listing || !listing.items.length) return { articles, positions };
    if (offset >= listing.items.length) {
      if (!listing.hasNext) return { articles, positions };
      page += 1;
      offset = 0;
      continue;
    }
    const take = Math.min(limit - articles.length, listing.items.length - offset);
    for (let index = 0; index < take; index++) positions.push({ page, offset: offset + index });
    articles.push(...listing.items.slice(offset, offset + take));
    offset += take;
    if (offset === listing.items.length) {
      if (!listing.hasNext) return { articles, positions };
      page += 1;
      offset = 0;
    }
  }
  return { articles, positions, nextCursor: page <= 10000 ? { page, offset } : undefined };
}

export async function verifySelectedArticles(
  selection: SelectionRequest,
  loadPage: (page: number) => Promise<BlogArticlePage | null>,
): Promise<BlogArticle[]> {
  if (selection.range !== "selected" || !selection.articles) return [];
  const pages = [...new Set(selection.articles.map(({ sourcePage }) => sourcePage))];
  const officialArticles = new Map<number, Map<string, BlogArticle>>();
  for (let index = 0; index < pages.length; index += 2) {
    await Promise.all(pages.slice(index, index + 2).map(async (page) => {
      const listing = await loadPage(page);
      officialArticles.set(page, new Map(listing?.items.map((article) =>
        [normalizeArticleUrl(article.url, undefined, selection.group), article]) ?? []));
    }));
  }
  return selection.articles.map(({ url, sourcePage }) => {
    const article = officialArticles.get(sourcePage)?.get(url);
    if (!article) {
      throw new SelectionError("選択したブログが、このメンバーの公式一覧にありません。ブログを選び直してください。");
    }
    return article;
  });
}

export async function collectLatestArticles(
  count: number,
  loadPage: (page: number) => Promise<BlogArticlePage | null>,
): Promise<BlogArticle[]> {
  const articles: BlogArticle[] = [];
  for (let page = 1; page <= count && articles.length < count; page += 1) {
    const listing = await loadPage(page);
    if (!listing || listing.items.length === 0) break;
    articles.push(...listing.items.slice(0, count - articles.length));
    if (!listing.hasNext) break;
  }
  return articles;
}
