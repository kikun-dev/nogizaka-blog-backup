import { getArticlePage, getAuthors, groupSelectionAuthor } from "../server/catalog";
import { ALL_AUTHORS_ID, collectLatestArticles, validateSelection, verifySelectedArticles } from "../lib/selection";
import type { LocalJob } from "../server/job-store";
import type { PublicJobRow } from "../server/public-store";

export async function resolvePublicJob(row: PublicJobRow, outputDirectory: string): Promise<LocalJob> {
  let articles: NonNullable<LocalJob["requestedArticles"]>;
  let author: NonNullable<LocalJob["requestedAuthor"]>;
  if ("retryArticles" in row.request) {
    articles = row.request.retryArticles;
    author = row.request.author;
    if (!articles.length || articles.length > (row.kind === "photos" ? 20 : 10)) throw new Error("再試行する記事を確認してください。");
  } else if ("confirmedArticles" in row.request) {
    const selection = validateSelection(row.request.selection);
    if (selection.range === "all" || selection.content !== row.kind) throw new Error("公開版で利用できない取得条件です。");
    articles = row.request.confirmedArticles;
    author = row.request.confirmedAuthor;
    if (!articles.length || articles.length > (row.kind === "photos" ? 20 : 10)
      || author.group !== selection.group || author.id !== selection.authorId) {
      throw new Error("確認したブログを読み取れませんでした。");
    }
  } else {
    // Jobs queued before the confirmation snapshot was introduced retain their old request shape.
    const selection = validateSelection(row.request.selection);
    if (selection.range === "all" || selection.content !== row.kind) throw new Error("公開版で利用できない取得条件です。");
    author = selection.authorId === ALL_AUTHORS_ID
      ? groupSelectionAuthor(selection.group)
      : (await getAuthors(selection.group)).find(({ id }) => id === selection.authorId)!;
    if (!author) throw new Error("公式一覧にない投稿者です。");
    const loadPage = (page: number) => getArticlePage(selection.group, author.id, page);
    articles = selection.range === "selected"
      ? await verifySelectedArticles(selection, loadPage)
      : await collectLatestArticles(selection.range === "latest-one" ? 1 : selection.count!, loadPage);
    if (!articles.length) throw new Error("取得する記事が見つかりませんでした。");
  }
  return {
    id: row.id, articleUrl: articles[0].url, kind: row.kind,
    requestedArticles: articles, requestedAuthor: author,
    status: "running", createdAt: row.created_at, updatedAt: row.updated_at,
    outputDirectory, log: [], retryOfJobId: row.retry_of_job_id ?? undefined,
  };
}
