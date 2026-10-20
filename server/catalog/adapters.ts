import type { Page } from "playwright";
import type { BlogArticle, BlogArticlePage, BlogAuthor, BlogGroup, BlogAuthorType } from "@/lib/catalog/types";

type RawAuthor = { id: string; name: string };
type RawArticle = { id: string; title: string; date: string; url: string; excerpt?: string; authorName?: string };
type SiteAdapter = {
  origin: string;
  authorPath: string;
  listPath: string;
  readAuthors: (page: Page) => Promise<RawAuthor[]>;
  readArticles: (page: Page) => Promise<{ items: RawArticle[]; hasNext: boolean }>;
};

export class ArticleAuthorError extends Error {}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
// The official Sakurazaka selector still links to ct=06, but that URL now redirects to Not Found.
const unavailableSakurazakaAuthorIds = new Set(["06"]);

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
          authorName: link.querySelector(".prof .name")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
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
            authorName: card.querySelector(".c-blog-article__name")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
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

export function groupArticlesUrl(group: BlogGroup, page: number): string {
  const adapter = adapters[group];
  const url = new URL(adapter.listPath, adapter.origin);
  if (page > 1) url.searchParams.set("page", String(page - 1));
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
    if (group === "sakurazaka" && unavailableSakurazakaAuthorIds.has(id)) return false;
    seen.add(id);
    return true;
  }).map(({ id, name }) => ({
    id, name: clean(name), type: authorType(group, name), group,
    listUrl: authorListUrl(group, id),
  }));
  if (authors.length === 0) throw new Error("公式サイトのメンバー一覧を読み取れませんでした。");
  return authors;
}

export async function readArticles(group: BlogGroup, author: BlogAuthor, page: Page, pageNumber: number): Promise<BlogArticlePage> {
  const raw = await adapters[group].readArticles(page);
  const items: BlogArticle[] = raw.items.filter((item) => isValidArticle(group, item)).map(({ id, title, date, url, excerpt }) => ({
    id,
    title: clean(title) || "無題のブログ",
    ...(excerpt && !clean(title) ? { excerpt: clean(excerpt) } : {}),
    date: clean(date).replace(/[./]/g, "-"),
    url,
    author,
  }));
  return { items, page: pageNumber, hasNext: raw.hasNext };
}

function isValidArticle(group: BlogGroup, { id, url }: RawArticle): boolean {
  const origin = adapters[group].origin;
  if (!/^\d+$/.test(id)) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && /\/diary\/detail\/\d+$/.test(parsed.pathname);
  } catch { return false; }
}

async function nogizakaAuthorId(page: Page, url: string): Promise<string> {
  const response = await page.request.get(url, { timeout: 30_000 });
  if (!response.ok() || new URL(response.url()).origin !== adapters.nogizaka.origin
    || new URL(response.url()).pathname !== new URL(url).pathname) {
    throw new ArticleAuthorError("乃木坂46のブログ投稿者を確認できませんでした。時間をおいて一覧を再読み込みしてください。");
  }
  const html = await response.text();
  if (html.length > 2_000_000) throw new ArticleAuthorError("乃木坂46のブログ投稿者を確認できませんでした。時間をおいて一覧を再読み込みしてください。");
  return parseNogizakaAuthorId(html, response.url());
}

export function parseNogizakaAuthorId(html: string, baseUrl: string): string {
  const profile = [...html.matchAll(/<a\b[^>]*>/gi)].map(([tag]) => tag)
    .find((tag) => /\bbd--prof__tex__a\b/.test(tag));
  const href = profile?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  const authorUrl = href ? new URL(href, baseUrl) : null;
  const authorId = authorUrl?.origin === adapters.nogizaka.origin
    && authorUrl.pathname === adapters.nogizaka.listPath ? authorUrl.searchParams.get("ct") : null;
  if (!authorId || !isAuthorId(authorId)) throw new ArticleAuthorError("乃木坂46のブログ投稿者を確認できませんでした。時間をおいて一覧を再読み込みしてください。");
  return authorId;
}

export async function readGroupArticles(group: BlogGroup, authors: BlogAuthor[], page: Page, pageNumber: number): Promise<BlogArticlePage> {
  const raw = await adapters[group].readArticles(page);
  const valid = raw.items.filter((item) => isValidArticle(group, item));
  if (valid.length !== raw.items.length) {
    throw new ArticleAuthorError("公式ブログの記事を確認できませんでした。時間をおいて一覧を再読み込みしてください。");
  }
  const byId = new Map(authors.map((author) => [author.id, author]));
  const byName = new Map<string, BlogAuthor | null>();
  for (const author of authors) {
    const name = author.name.normalize("NFKC").replace(/\s+/g, "");
    byName.set(name, byName.has(name) ? null : author);
  }
  const items: BlogArticle[] = [];
  for (let start = 0; start < valid.length; start += 4) {
    const batch = await Promise.all(valid.slice(start, start + 4).map(async (item) => {
      const author = group === "nogizaka"
        ? byId.get(await nogizakaAuthorId(page, item.url))
        : byName.get((item.authorName ?? "").normalize("NFKC").replace(/\s+/g, ""));
      if (!author) throw new ArticleAuthorError("公式ブログの投稿者を特定できませんでした。時間をおいて一覧を再読み込みしてください。");
      return {
        id: item.id,
        title: clean(item.title) || "無題のブログ",
        ...(item.excerpt && !clean(item.title) ? { excerpt: clean(item.excerpt) } : {}),
        date: clean(item.date).replace(/[./]/g, "-"),
        url: item.url,
        author,
      };
    }));
    items.push(...batch);
  }
  return { items, page: pageNumber, hasNext: raw.hasNext };
}
