import type { BlogArticle, BlogArticlePage } from "./catalog/types";

export type ArticleCursor = { sourcePage: number; offset: number };
export type ListedArticle = { article: BlogArticle; sourcePage: number };
export type SelectionArticlePage = {
  items: ListedArticle[];
  page: number;
  nextCursor: ArticleCursor | null;
};

export function paginateArticles(
  first: BlogArticlePage,
  second: BlogArticlePage | null,
  cursor: ArticleCursor,
  page: number,
  limit: number,
): SelectionArticlePage {
  const firstItems = first.items.slice(cursor.offset);
  const firstUsed = Math.min(firstItems.length, limit);
  const secondItems = second?.items ?? [];
  const secondUsed = Math.min(secondItems.length, limit - firstUsed);
  const items = [
    ...firstItems.slice(0, firstUsed).map((article) => ({ article, sourcePage: cursor.sourcePage })),
    ...secondItems.slice(0, secondUsed).map((article) => ({ article, sourcePage: cursor.sourcePage + 1 })),
  ];

  let nextCursor: ArticleCursor | null = null;
  if (cursor.offset + firstUsed < first.items.length) {
    nextCursor = { sourcePage: cursor.sourcePage, offset: cursor.offset + firstUsed };
  } else if (second && secondUsed < second.items.length) {
    nextCursor = { sourcePage: cursor.sourcePage + 1, offset: secondUsed };
  } else if (second?.hasNext) {
    nextCursor = { sourcePage: cursor.sourcePage + 2, offset: 0 };
  } else if (!second && first.hasNext) {
    nextCursor = { sourcePage: cursor.sourcePage + 1, offset: 0 };
  }

  return { items, page, nextCursor };
}
