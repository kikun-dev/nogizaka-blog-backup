import { normalizeArticleUrl } from "./archive/urls.mjs";
import type { BlogArticle, BlogAuthor, BlogGroup } from "./catalog/types";

export type SelectionContent = "photos" | "blog";
export type SelectionRange = "latest-one" | "latest-n" | "selected" | "all";

export type SelectionRequest = {
  group: BlogGroup;
  authorId: string;
  content: SelectionContent;
  range: SelectionRange;
  count?: number;
  urls?: string[];
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
    if (!Array.isArray(value.urls) || value.urls.length === 0 || value.urls.length > limit) {
      throw new SelectionError(`選べる記事は最大${limit}件です。`);
    }
    const urls = value.urls.map((url) => {
      if (typeof url !== "string" || url.length > 2048) throw new SelectionError("記事URLを確認してください。");
      try { return normalizeArticleUrl(url, undefined, selection.group); }
      catch { throw new SelectionError("選択した記事に別グループのURLが含まれています。"); }
    });
    if (new Set(urls).size !== urls.length) throw new SelectionError("同じ記事を重複して選択できません。");
    selection.urls = urls;
  } else if (value.urls !== undefined) {
    throw new SelectionError("記事URLの指定が取得範囲と一致しません。");
  }

  return selection;
}
