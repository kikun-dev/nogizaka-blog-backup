import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BlogArticle } from "@/lib/catalog/types";
import { normalizeArticleUrl } from "@/lib/archive/urls.mjs";
import type { PhotoArticle, SavedPhoto } from "./job-store";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_PHOTOS_PER_ARTICLE = 150;
const imageTypes: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "image/avif": "avif",
};

type ImageCandidate = { urls: string[] };

function allowedImageUrl(value: string, article: BlogArticle): boolean {
  try {
    const url = new URL(value);
    const domain = { nogizaka: "nogizaka46.com", sakurazaka: "sakurazaka46.com", hinatazaka: "hinatazaka46.com" }[article.author.group];
    return url.protocol === "https:" && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

export async function extractPhotoCandidates(page: Page): Promise<ImageCandidate[]> {
  return page.evaluate(() => {
    const root = [".bd--edit", ".c-blog-article__text", ".p-blog-article__text", ".box-article", ".p-blog-article", "article"]
      .map((selector) => document.querySelector(selector)).find(Boolean);
    if (!root) throw new Error("ブログ本文を見つけられませんでした。");
    return Array.from(root.querySelectorAll("img"))
      .filter((image) => !image.closest("header,footer,nav,[class*='banner'],[class*='bnr'],[class*='share'],[class*='sns']"))
      .filter((image) => !image.naturalWidth || image.naturalWidth >= 100 || image.naturalHeight >= 100)
      .slice(0, 150)
      .map((image) => {
        const srcset = [image.getAttribute("data-srcset"), image.getAttribute("srcset")]
          .filter(Boolean)
          .flatMap((value) => value!.split(",").map((part) => {
            const [url, size] = part.trim().split(/\s+/);
            return { url, size: Number.parseInt(size, 10) || 0 };
          }))
          .sort((a, b) => b.size - a.size).map(({ url }) => url);
        const raw = [
          image.getAttribute("data-original"), image.getAttribute("data-full"), image.getAttribute("data-src"),
          ...srcset, image.currentSrc, image.getAttribute("src"),
        ];
        const urls = [...new Set(raw.filter((value): value is string => Boolean(value))
          .map((value) => { try { return new URL(value, document.baseURI).href; } catch { return ""; } })
          .filter(Boolean))];
        return { urls };
      }).filter(({ urls }) => urls.length > 0);
  });
}

function validImage(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/gif") return bytes.toString("ascii", 0, 3) === "GIF";
  if (mimeType === "image/webp") return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (mimeType === "image/avif") return bytes.toString("ascii", 4, 12).includes("ftypavif");
  return false;
}

export async function acquirePhotos(articles: BlogArticle[], outputDirectory: string): Promise<PhotoArticle[]> {
  const browser = await chromium.launch({ headless: true });
  const results: PhotoArticle[] = [];
  try {
    const context = await browser.newContext({ locale: "ja-JP" });
    const page = await context.newPage();
    for (const article of articles) {
      const result: PhotoArticle = {
        id: article.id, title: article.title, date: article.date, authorName: article.author.name,
        photos: [], detected: 0, failed: 0,
      };
      results.push(result);
      try {
        const expected = normalizeArticleUrl(article.url, undefined, article.author.group);
        const response = await page.goto(expected, { waitUntil: "domcontentloaded", timeout: 60_000 });
        if (!response?.ok() || new URL(normalizeArticleUrl(page.url(), undefined, article.author.group)).pathname !== new URL(expected).pathname) {
          throw new Error("公式ブログを開けませんでした。");
        }
        await page.locator(".bd--edit, .c-blog-article__text, .p-blog-article__text, .box-article, .p-blog-article, article").first().waitFor({ timeout: 30_000 });
        await page.evaluate(async () => {
          for (let position = 0; position < document.documentElement.scrollHeight; position += 600) {
            window.scrollTo(0, position);
            await new Promise((resolve) => setTimeout(resolve, 80));
          }
          window.scrollTo(0, 0);
          await new Promise((resolve) => setTimeout(resolve, 500));
        });
        const candidates = await extractPhotoCandidates(page);
        result.detected = candidates.length;
        const directory = path.join(outputDirectory, "photos", article.id);
        await mkdir(directory, { recursive: true });
        const seen = new Set<string>();
        for (const candidate of candidates.slice(0, MAX_PHOTOS_PER_ARTICLE)) {
          let saved: SavedPhoto | undefined;
          for (const url of candidate.urls) {
            if (!allowedImageUrl(url, article)) continue;
            try {
              const image = await context.request.get(url, { timeout: 30_000, maxRedirects: 0, failOnStatusCode: false, headers: { Referer: page.url() } });
              const mimeType = image.headers()["content-type"]?.split(";")[0]?.toLowerCase() ?? "";
              if (!image.ok() || !imageTypes[mimeType] || Number(image.headers()["content-length"] ?? 0) > MAX_IMAGE_BYTES) continue;
              const bytes = await image.body();
              if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !validImage(bytes, mimeType)) continue;
              if (seen.has(url)) { saved = { name: "", mimeType }; break; }
              const name = `photo-${String(result.photos.length + 1).padStart(3, "0")}.${imageTypes[mimeType]}`;
              await writeFile(path.join(directory, name), bytes);
              seen.add(url);
              saved = { name, mimeType };
              result.photos.push(saved);
              break;
            } catch { /* Try the next candidate, then count a failure. */ }
          }
          if (!saved) result.failed += 1;
        }
        result.failed += Math.max(0, candidates.length - MAX_PHOTOS_PER_ARTICLE);
      } catch (error) {
        result.error = error instanceof Error ? error.message : "ブログ本文を取得できませんでした。";
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}
