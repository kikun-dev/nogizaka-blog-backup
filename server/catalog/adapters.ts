import type { Page } from "playwright";
import type { BlogArticle, BlogArticlePage, BlogAuthor, BlogGroup, BlogAuthorType } from "@/lib/catalog/types";

type RawAuthor = { id: string; name: string };
type RawArticle = { id: string; title: string; date: string; url: string; excerpt?: string };
type SiteAdapter = {
  origin: string;
  authorPath: string;
  listPath: string;
  readAuthors: (page: Page) => Promise<RawAuthor[]>;
  readArticles: (page: Page) => Promise<{ items: RawArticle[]; hasNext: boolean }>;
};

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

const adapters: Record<BlogGroup, SiteAdapter> = {
  nogizaka: {
    origin: "https://www.nogizaka46.com",
    authorPath: "/s/n46/diary/MEMBER",
    listPath: "/s/n46/diary/MEMBER/list",
    readAuthors: (page) => page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>(".ba--ml__one__a[href*='ct=']"))
        .map((link) => ({
          id: new URL(link.href).searchParams.get("ct") ?? "",
          name: link.querySelector(".ba--ml__one__name")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        }))),
    readArticles: (page) => page.evaluate(() => ({
      items: Array.from(document.querySelectorAll<HTMLAnchorElement>(".bl--list a.bl--card[href*='/diary/detail/']"))
        .map((link) => ({
          id: new URL(link.href).pathname.match(/\/detail\/(\d+)/)?.[1] ?? "",
          title: link.querySelector(".bl--card__ttl")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          date: link.querySelector(".bl--card__date")?.textContent?.trim() ?? "",
          url: link.href,
        })),
      hasNext: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='page=']"))
        .some((link) => Number(new URL(link.href).searchParams.get("page")) ===
          Number(new URL(location.href).searchParams.get("page") ?? "0") + 1),
    })),
  },
  sakurazaka: {
    origin: "https://sakurazaka46.com",
    authorPath: "/s/s46/diary/blog/list",
    listPath: "/s/s46/diary/blog/list",
    readAuthors: (page) => page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>(".com-blog-circle a[href*='ct=']"))
        .map((link) => ({
          id: new URL(link.href).searchParams.get("ct") ?? "",
          name: link.querySelector(".name")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        }))),
    readArticles: (page) => page.evaluate(() => ({
      items: Array.from(document.querySelectorAll<HTMLAnchorElement>(".com-blog-part li.box > a[href*='/diary/detail/']"))
        .map((link) => ({
          id: new URL(link.href).pathname.match(/\/detail\/(\d+)/)?.[1] ?? "",
          title: link.querySelector(".date-title .title")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          excerpt: link.querySelector(".lead")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          date: link.querySelector(".date-title .date")?.textContent?.trim() ?? "",
          url: link.href,
        })),
      hasNext: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='page=']"))
        .some((link) => Number(new URL(link.href).searchParams.get("page")) ===
          Number(new URL(location.href).searchParams.get("page") ?? "0") + 1),
    })),
  },
  hinatazaka: {
    origin: "https://www.hinatazaka46.com",
    authorPath: "/s/official/diary/member",
    listPath: "/s/official/diary/member/list",
    readAuthors: (page) => page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>(".p-blog-face__list[href*='ct=']"))
        .map((link) => ({
          id: new URL(link.href).searchParams.get("ct") ?? "",
          name: link.querySelector(".c-blog-face__name")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        }))),
    readArticles: (page) => page.evaluate(() => ({
      items: Array.from(document.querySelectorAll<HTMLElement>(".p-blog-article"))
        .map((card) => {
          const link = card.querySelector<HTMLAnchorElement>("a[href*='/diary/detail/']");
          return {
            id: link ? new URL(link.href).pathname.match(/\/detail\/(\d+)/)?.[1] ?? "" : "",
            title: card.querySelector(".c-blog-article__title")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
            date: card.querySelector(".c-blog-article__date")?.textContent?.trim() ?? "",
            url: link?.href ?? "",
          };
        }),
      hasNext: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='page=']"))
        .some((link) => Number(new URL(link.href).searchParams.get("page")) ===
          Number(new URL(location.href).searchParams.get("page") ?? "0") + 1),
    })),
  },
};

export function isBlogGroup(value: string): value is BlogGroup {
  return Object.hasOwn(adapters, value);
}

export function isAuthorId(value: string): boolean {
  return /^\d{1,8}$/.test(value);
}

function authorType(group: BlogGroup, name: string): BlogAuthorType {
  if (/期生/.test(name)) return "generation";
  if (/スタッフ|運営/.test(name)) return "staff";
  if (group === "hinatazaka" && name === "ポカ") return "mascot";
  return "member";
}

export function authorListUrl(group: BlogGroup, id: string): string {
  const adapter = adapters[group];
  const url = new URL(adapter.listPath, adapter.origin);
  url.searchParams.set("ct", id);
  return url.href;
}

export function authorsUrl(group: BlogGroup): string {
  const adapter = adapters[group];
  return new URL(adapter.authorPath, adapter.origin).href;
}

export function articlesUrl(group: BlogGroup, id: string, page: number): string {
  const url = new URL(authorListUrl(group, id));
  if (page > 1) url.searchParams.set("page", String(page - 1));
  return url.href;
}

export async function readAuthors(group: BlogGroup, page: Page): Promise<BlogAuthor[]> {
  const raw = await adapters[group].readAuthors(page);
  const seen = new Set<string>();
  const authors = raw.filter(({ id, name }) => {
    if (!isAuthorId(id) || !clean(name) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(({ id, name }) => ({
    id, name: clean(name), type: authorType(group, name), group,
    listUrl: authorListUrl(group, id),
  }));
  if (authors.length === 0) throw new Error("公式サイトのブログ主体一覧を読み取れませんでした。");
  return authors;
}

export async function readArticles(group: BlogGroup, author: BlogAuthor, page: Page, pageNumber: number): Promise<BlogArticlePage> {
  const raw = await adapters[group].readArticles(page);
  const origin = adapters[group].origin;
  const items: BlogArticle[] = raw.items.filter(({ id, url }) => {
    if (!/^\d+$/.test(id)) return false;
    try {
      const parsed = new URL(url);
      return parsed.origin === origin && /\/diary\/detail\/\d+$/.test(parsed.pathname);
    } catch { return false; }
  }).map(({ id, title, date, url, excerpt }) => ({
    id,
    title: clean(title) || "無題の記事",
    ...(excerpt && !clean(title) ? { excerpt: clean(excerpt) } : {}),
    date: clean(date).replace(/[./]/g, "-"),
    url,
    author,
  }));
  return { items, page: pageNumber, hasNext: raw.hasNext };
}
