import { normalizeArticleUrl } from "../lib/archive/urls.mjs";
import type { BlogArticle, BlogAuthor } from "../lib/catalog/types";
import { ALL_AUTHORS_ID, SELECTION_LIMITS, SelectionError, validateSelection, type SelectionRequest } from "../lib/selection";
import type { CatalogQueryRow, PublicRequest } from "./public-store";

const CONFIRMATION_LIFETIME_MS = 15 * 60 * 1000;

function validAuthor(value: unknown, group: string): value is BlogAuthor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const author = value as Record<string, unknown>;
  return author.group === group && typeof author.id === "string" && /^(all|\d{1,8})$/.test(author.id)
    && typeof author.name === "string" && author.name.length > 0
    && ["member", "generation", "staff", "mascot", "other"].includes(author.type as string)
    && typeof author.listUrl === "string";
}

export function confirmedJobRequest(selection: SelectionRequest, query: CatalogQueryRow | null,
  now = Date.now()): PublicRequest {
  if (!query || query.status !== "succeeded" || query.request.kind !== "selection"
    || !Number.isFinite(Date.parse(query.created_at))
    || Date.parse(query.created_at) > now || now - Date.parse(query.created_at) > CONFIRMATION_LIFETIME_MS) {
    throw new SelectionError("確認結果の期限が切れました。取得条件をもう一度確認してください。");
  }
  if (JSON.stringify(validateSelection(query.request.selection)) !== JSON.stringify(selection)) {
    throw new SelectionError("確認した取得条件と一致しません。もう一度確認してください。");
  }
  const plan = query.result?.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new SelectionError("確認結果を読み取れませんでした。もう一度確認してください。");
  const { author, previewArticles } = plan as { author?: unknown; previewArticles?: unknown };
  const expectedCount = selection.range === "latest-one" ? 1
    : selection.range === "latest-n" ? selection.count! : selection.articles?.length ?? 0;
  if (!validAuthor(author, selection.group) || author.id !== selection.authorId
    || !Array.isArray(previewArticles) || previewArticles.length < 1
    || previewArticles.length > Math.min(expectedCount, SELECTION_LIMITS[selection.content])
    || (selection.range !== "latest-n" && previewArticles.length !== expectedCount)) {
    throw new SelectionError("確認したブログを読み取れませんでした。もう一度確認してください。");
  }
  const articles: BlogArticle[] = [];
  for (const raw of previewArticles) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SelectionError("確認したブログを読み取れませんでした。");
    const article = raw as Partial<BlogArticle>;
    if (typeof article.id !== "string" || !/^\d+$/.test(article.id)
      || typeof article.url !== "string" || typeof article.title !== "string" || typeof article.date !== "string"
      || !validAuthor(article.author, selection.group)
      || (selection.authorId !== ALL_AUTHORS_ID && article.author.id !== selection.authorId)) {
      throw new SelectionError("確認したブログを読み取れませんでした。");
    }
    try {
      const url = normalizeArticleUrl(article.url, undefined, selection.group);
      if (new URL(url).pathname.split("/").at(-1) !== article.id) throw new Error("記事ID");
      articles.push({ ...article, url } as BlogArticle);
    } catch { throw new SelectionError("確認したブログのURLを読み取れませんでした。"); }
  }
  if (selection.range === "selected" && articles.some((article, index) =>
    new URL(article.url).pathname !== new URL(selection.articles![index].url).pathname)) {
    throw new SelectionError("選択したブログと確認結果が一致しません。もう一度確認してください。");
  }
  return { selection, confirmedArticles: articles, confirmedAuthor: author };
}
