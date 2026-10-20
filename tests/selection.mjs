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
assert.equal(validateSelection({ ...base, authorId: "all", range: "latest-one" }).authorId, "all");
assert.equal(validateSelection({ ...base, authorId: "all", content: "blog", range: "latest-n", count: 3 }).count, 3);

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
  { ...base, authorId: "all", content: "blog", range: "all" },
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

const secondArticle = article.replace("123", "456");
const groupSelection = validateSelection({ ...base, authorId: "all", content: "blog", range: "selected",
  articles: [{ url: article, sourcePage: 1 }, { url: secondArticle, sourcePage: 2 }] });
const groupPages = {
  1: { items: [{ url: article, id: "123", author: { id: "1", name: "投稿者 A" } }], page: 1, hasNext: true },
  2: { items: [{ url: secondArticle, id: "456", author: { id: "2", name: "投稿者 B" } }], page: 2, hasNext: false },
};
assert.deepEqual((await verifySelectedArticles(groupSelection, async (page) => groupPages[page]))
  .map(({ author }) => author.id), ["1", "2"]);

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
assert.deepEqual(batchOne.nextCursor, { page: 2, offset: 3, afterArticleId: "10" });
assert.deepEqual(batchOne.positions[7], { page: 2, offset: 0 });
const batchTwo = await collectBulkBatch(loadBulk, batchOne.nextCursor);
assert.deepEqual(batchTwo.articles.map(({ id }) => Number(id)), Array.from({ length: 8 }, (_, index) => index + 11));
assert.equal(batchTwo.nextCursor, undefined);
assert.deepEqual(batchTwo.positions[0], { page: 2, offset: 3 });

await assert.rejects(collectBulkBatch(async (page) => page === 1 ? source(1, 1, 2) : null),
  /公式一覧を確認できませんでした/);
await assert.rejects(collectBulkBatch(async (page) => page === 1 ? source(1, 1, 2) : source(2, 3, 0, false)),
  /公式一覧を確認できませんでした/);

const shifted = { 1: source(1, 1, 3), 2: source(2, 4, 3, false) };
const beforeShift = await collectBulkBatch(async (page) => shifted[page], undefined, 4);
assert.equal(beforeShift.nextCursor.afterArticleId, "4");
shifted[1] = { ...shifted[1], items: [...shifted[1].items.slice(1), shifted[2].items[0]] };
shifted[2] = { ...shifted[2], items: [shifted[2].items[1], shifted[2].items[2]] };
const afterShift = await collectBulkBatch(async (page) => shifted[page], beforeShift.nextCursor, 10,
  new Set(beforeShift.articles.map(({ id }) => id)));
assert.deepEqual(afterShift.articles.map(({ id }) => id), ["5", "6"]);

const removedAnchor = { 1: source(1, 1, 3), 2: source(2, 4, 3, false) };
const prior = await collectBulkBatch(async (page) => removedAnchor[page], undefined, 3);
removedAnchor[1] = { ...removedAnchor[1], items: removedAnchor[1].items.filter(({ id }) => id !== "3") };
const recovered = await collectBulkBatch(async (page) => removedAnchor[page], prior.nextCursor, 10,
  new Set(prior.articles.map(({ id }) => id)));
assert.deepEqual(recovered.articles.map(({ id }) => id), ["4", "5", "6"]);

console.log("Selection limits, ownership, and pagination passed");
