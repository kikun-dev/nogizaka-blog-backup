import { chromium, type Browser, type Page } from "playwright";
import type { BlogArticlePage, BlogAuthor, BlogGroup } from "@/lib/catalog/types";
import { ALL_AUTHORS_ID } from "@/lib/selection";
import { articlesUrl, authorsUrl, groupArticlesUrl, readArticles, readAuthors, readGroupArticles } from "./adapters";
import { isExpectedListingUrl } from "./listing-url";

const CACHE_MS = 5 * 60 * 1000;
const MAX_ACTIVE = 2;
const MAX_WAITING = 20;
const MAX_CACHE_ENTRIES = 300;
const cache = new Map<string, { expires: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();
let active = 0;
const waiting: Array<() => void> = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING) throw new Error("一覧取得が混み合っています。少し待って再試行してください。");
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  else active += 1;
  try { return await work(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

async function withListingPage<T>(url: string, read: (page: Page) => Promise<T>): Promise<T> {
  return slot(async () => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.route("**/*", (route) => {
        return route.request().resourceType() === "document" ? route.continue() : route.abort();
      });
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (!response?.ok()) throw new Error(`公式サイトの一覧を取得できませんでした（HTTP ${response?.status() ?? "不明"}）。`);
      if (!isExpectedListingUrl(url, page.url())) {
        throw new Error("公式サイトの一覧URLが別のページへ移動したため、取得できませんでした。");
      }
      return await read(page);
    } finally {
      await browser?.close();
    }
  });
}

async function cached<T>(key: string, work: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const promise = work().then((value) => {
    for (const [cachedKey, entry] of cache) {
      if (entry.expires <= Date.now()) cache.delete(cachedKey);
    }
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + CACHE_MS, value });
    return value;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export function getAuthors(group: BlogGroup): Promise<BlogAuthor[]> {
  return cached(`authors:${group}`, () => withListingPage(authorsUrl(group), (page) => readAuthors(group, page)));
}

export function groupSelectionAuthor(group: BlogGroup): BlogAuthor {
  return { id: ALL_AUTHORS_ID, name: "全件", type: "other", group, listUrl: groupArticlesUrl(group, 1) };
}

export async function getArticlePage(group: BlogGroup, authorId: string, pageNumber: number): Promise<BlogArticlePage | null> {
  if (authorId === ALL_AUTHORS_ID) {
    const authors = await getAuthors(group);
    return cached(`articles:${group}:${ALL_AUTHORS_ID}:${pageNumber}`, () =>
      withListingPage(groupArticlesUrl(group, pageNumber), (page) => readGroupArticles(group, authors, page, pageNumber)));
  }
  const author = (await getAuthors(group)).find(({ id }) => id === authorId);
  if (!author) return null;
  return cached(`articles:${group}:${authorId}:${pageNumber}`, () =>
    withListingPage(articlesUrl(group, authorId, pageNumber), (page) => readArticles(group, author, page, pageNumber)));
}
