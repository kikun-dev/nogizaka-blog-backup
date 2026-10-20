import assert from "node:assert/strict";
import { SELECTION_LIMITS, SelectionError, collectBulkBatch, collectLatestArticles, validateSelection, verifySelectedArticles } from "../lib/selection.ts";
import { paginateArticles } from "../lib/selection-pages.ts";

const base = { group: "hinatazaka", authorId: "000", content: "photos" };
const article = "https://www.hinatazaka46.com/s/official/diary/detail/123?ima=0000&cd=member";
assert.equal(SELECTION_LIMITS.photos, 20);
assert.equal(SELECTION_LIMITS.blog, 10);
assert.deepEqual(validateSelection({ ...base, range: "latest-one" }), { ...base, range: "latest-one" });
assert.equal(validateSelection({ ...base, range: "latest-n", count: 20 }).count, 20);
assert.equal(validateSelection({ ...base, content: "blog", range: "latest-n", count: 10 }).count, 10);
const selectedArticle = { url: article, sourcePage: 2 };
assert.equal(validateSelection({ ...base, range: "selected", articles: [selectedArticle] }).articles[0].url.includes("ima="), false);
assert.equal(validateSelection({ ...base, content: "blog", range: "all" }).range, "all");

for (const invalid of [
  { ...base, range: "latest-n", count: 21 },
  { ...base, content: "blog", range: "latest-n", count: 11 },
  { ...base, range: "selected", articles: Array.from({ length: 21 }, (_, id) => ({ url: article.replace("123", String(id + 1)), sourcePage: 1 })) },
  { ...base, range: "selected", articles: [selectedArticle, selectedArticle] },
  { ...base, range: "selected", articles: [{ url: "https://example.com/article", sourcePage: 2 }] },
  { ...base, range: "selected", articles: [{ url: article, sourcePage: 0 }] },
  { ...base, range: "latest-one", articles: [selectedArticle] },
  { ...base, authorId: "../06", range: "all" },
  { ...base, range: "all" },
  { ...base, content: "blog", range: "all", cursor: { page: -1, offset: 0 } },
  { ...base, content: "blog", range: "all", cursor: { page: 2, offset: 4 } },
  { ...base, content: "blog", range: "latest-one", cursor: { page: 1, offset: 0 } },
]) {
  assert.throws(() => validateSelection(invalid), SelectionError);
}

const validSelection = validateSelection({ ...base, range: "selected", articles: [selectedArticle] });
const listedPage = { items: [{ url: article, id: "123", title: "選択したブログ", date: "2026-10-19 12:00" }], page: 2, hasNext: false };
assert.equal((await verifySelectedArticles(validSelection, async (page) => page === 2 ? listedPage : null))[0].title, "選択したブログ");
await assert.rejects(
  verifySelectedArticles(validSelection, async () => ({ ...listedPage, items: [{ url: article.replace("123", "456"), id: "456" }] })),
  SelectionError,
);
await assert.rejects(verifySelectedArticles(validSelection, async () => null), SelectionError);

const source = (page, start, count, hasNext = true) => ({
  page,
  hasNext,
  items: Array.from({ length: count }, (_, index) => ({ id: String(start + index) })),
});
const first = source(1, 1, 12);
const second = source(2, 13, 13);
const third = source(3, 26, 10, false);
assert.deepEqual((await collectLatestArticles(20, async (page) => ({ 1: first, 2: second, 3: third })[page])).map(({ id }) => Number(id)), Array.from({ length: 20 }, (_, index) => index + 1));
assert.equal((await collectLatestArticles(20, async () => null)).length, 0);
const pageOne = paginateArticles(first, second, { sourcePage: 1, offset: 0 }, 1, 20);
assert.equal(pageOne.items.length, 20);
assert.deepEqual(pageOne.nextCursor, { sourcePage: 2, offset: 8 });
const pageTwo = paginateArticles(second, third, pageOne.nextCursor, 2, 20);
assert.deepEqual([...pageOne.items, ...pageTwo.items].map(({ article }) => Number(article.id)), Array.from({ length: 35 }, (_, index) => index + 1));
assert.equal(pageTwo.nextCursor, null);
const oversized = source(1, 1, 25);
const oversizedPage = paginateArticles(oversized, null, { sourcePage: 1, offset: 0 }, 1, 20);
assert.equal(oversizedPage.items.length, 20);
assert.deepEqual(oversizedPage.nextCursor, { sourcePage: 1, offset: 20 });
assert.equal(paginateArticles(oversized, second, oversizedPage.nextCursor, 2, 10).items.length, 10);

const bulkPages = { 1: source(1, 1, 7), 2: source(2, 8, 7), 3: source(3, 15, 4, false) };
const loadBulk = async (page) => bulkPages[page] ?? null;
const batchOne = await collectBulkBatch(loadBulk);
assert.deepEqual(batchOne.articles.map(({ id }) => Number(id)), Array.from({ length: 10 }, (_, index) => index + 1));
assert.deepEqual(batchOne.nextCursor, { page: 2, offset: 3 });
const batchTwo = await collectBulkBatch(loadBulk, batchOne.nextCursor);
assert.deepEqual(batchTwo.articles.map(({ id }) => Number(id)), Array.from({ length: 8 }, (_, index) => index + 11));
assert.equal(batchTwo.nextCursor, undefined);

console.log("Selection limits, ownership, and pagination passed");
