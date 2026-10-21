import { getArticlePage, getAuthors, groupSelectionAuthor } from "./catalog";
import { isAuthorId, isBlogGroup } from "./catalog/adapters";
import { ALL_AUTHORS_ID, SELECTION_LIMITS, collectLatestArticles, validateSelection, verifySelectedArticles } from "../lib/selection";
import type { CatalogQueryRequest } from "./public-store";

// Imported by the Node worker only. Every function below may launch Playwright.
export async function executeCatalogQuery(request: CatalogQueryRequest): Promise<Record<string, unknown>> {
  if (request.kind === "authors") {
    if (!isBlogGroup(request.group)) throw new Error("対象外のグループです。");
    return { authors: await getAuthors(request.group) };
  }
  if (request.kind === "articles") {
    if (!isBlogGroup(request.group) || (request.authorId !== ALL_AUTHORS_ID && !isAuthorId(request.authorId))
      || !Number.isSafeInteger(request.page) || request.page < 1 || request.page > 10000) {
      throw new Error("記事一覧の条件を確認してください。");
    }
    const articles = await getArticlePage(request.group, request.authorId, request.page);
    if (!articles) throw new Error("公式一覧にないメンバーです。");
    return { articles };
  }
  const selection = validateSelection(request.selection);
  if (selection.range === "all") throw new Error("公開版では全件バックアップを利用できません。");
  const author = selection.authorId === ALL_AUTHORS_ID
    ? groupSelectionAuthor(selection.group)
    : (await getAuthors(selection.group)).find(({ id }) => id === selection.authorId);
  if (!author) throw new Error("公式一覧にないメンバーです。");
  const loadPage = (page: number) => getArticlePage(selection.group, author.id, page);
  const previewArticles = selection.range === "selected"
    ? await verifySelectedArticles(selection, loadPage)
    : await collectLatestArticles(selection.range === "latest-one" ? 1 : selection.count!, loadPage);
  if (!previewArticles.length) throw new Error("ブログが見つかりませんでした。");
  return { plan: { ...selection, author, maxArticles: SELECTION_LIMITS[selection.content],
    firstArticle: previewArticles[0], previewArticles } };
}
