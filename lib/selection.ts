import { normalizeArticleUrl } from "./archive/urls.mjs";
import type { BlogArticle, BlogArticlePage, BlogAuthor, BlogGroup } from "./catalog/types";

export type SelectionContent = "photos" | "blog";
export type SelectionRange = "latest-one" | "latest-n" | "selected" | "all";
export type SelectedArticle = { url: string; sourcePage: number };

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
      throw new SelectionError(`最新の記事数は2〜${limit}件で指定してください。`);
    }
    selection.count = value.count as number;
  } else if (value.count !== undefined) {
    throw new SelectionError("記事数の指定が取得範囲と一致しません。");
  }

  if (value.range === "selected") {
    if (!Array.isArray(value.articles) || value.articles.length === 0 || value.articles.length > limit) {
      throw new SelectionError(`選べる記事は最大${limit}件です。`);
    }
    const articles = value.articles.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SelectionError("記事を確認してください。");
      const { url, sourcePage } = entry as Record<string, unknown>;
      if (typeof url !== "string" || url.length > 2048) throw new SelectionError("記事URLを確認してください。");
      if (!Number.isSafeInteger(sourcePage) || (sourcePage as number) < 1 || (sourcePage as number) > 10000) {
        throw new SelectionError("記事一覧のページ番号を確認してください。");
      }
      try { return { url: normalizeArticleUrl(url, undefined, selection.group), sourcePage: sourcePage as number }; }
      catch { throw new SelectionError("選択した記事に別グループのURLが含まれています。"); }
    });
    if (new Set(articles.map(({ url }) => new URL(url).pathname)).size !== articles.length) {
      throw new SelectionError("同じ記事を重複して選択できません。");
    }
    selection.articles = articles;
  } else if (value.articles !== undefined) {
    throw new SelectionError("記事の指定が取得範囲と一致しません。");
  }

  return selection;
}

export async function verifySelectedArticles(
  selection: SelectionRequest,
  loadPage: (page: number) => Promise<BlogArticlePage | null>,
): Promise<SelectedArticle[]> {
  if (selection.range !== "selected" || !selection.articles) return [];
  const pages = [...new Set(selection.articles.map(({ sourcePage }) => sourcePage))];
  const officialUrls = new Map<number, Set<string>>();
  for (let index = 0; index < pages.length; index += 2) {
    await Promise.all(pages.slice(index, index + 2).map(async (page) => {
      const listing = await loadPage(page);
      officialUrls.set(page, new Set(listing?.items.map(({ url }) => normalizeArticleUrl(url, undefined, selection.group)) ?? []));
    }));
  }
  for (const article of selection.articles) {
    if (!officialUrls.get(article.sourcePage)?.has(article.url)) {
      throw new SelectionError("選択した記事が、このメンバーの公式一覧にありません。記事を選び直してください。");
    }
  }
  return selection.articles;
}
