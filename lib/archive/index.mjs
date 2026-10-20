import { chromium } from "playwright";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { openAuthorStore } from "./author-store.mjs";
import { prepareArchiveView, saveMhtml, savePdf } from "./formats.mjs";
import { assertSameAuthor, markArticleVisited } from "./identity.mjs";
import { getMetadata } from "./metadata.mjs";
import { resolveOutputPath, safeName, sameAuthor } from "./paths.mjs";
import { readJson, writeJson } from "./storage.mjs";
import { openArticle } from "./source.mjs";
import { exists } from "./storage.mjs";
import { detectGroup, normalizeArticleUrl } from "./urls.mjs";

export { detectGroup, normalizeArticleUrl } from "./urls.mjs";
export { sameAuthor } from "./paths.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function articleIdentity(url, group) {
  const articleUrl = normalizeArticleUrl(url, undefined, group.key);
  const id = articleUrl.match(/\/detail\/(\d+)/)?.[1];
  if (!id) throw new Error("ブログIDの取得に失敗しました。");
  return { id, articleUrl };
}

async function readArticle(page, requestedUrl, group, logger, verifyImages = true) {
  const images = await openArticle(page, requestedUrl, {
    warn: (message) => logger.warn(message),
    verifyImages,
  });
  const metadata = await getMetadata(page, group);
  const { id, articleUrl } = articleIdentity(page.url(), group);
  if (!metadata.authorName) throw new Error("投稿主体名の取得に失敗しました。");
  return { id, articleUrl, images, ...metadata };
}

async function withPage(headed, callback) {
  const browser = await chromium.launch({ headless: !headed });
  try {
    const context = await browser.newContext({
      locale: "ja-JP",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    return await callback(context, page);
  } finally {
    await browser.close();
  }
}

// 保存前のメタデータ取得にも Web 側から利用できる入口。
export async function inspectArticle({ url, headed = false }, { logger = console } = {}) {
  const startUrl = normalizeArticleUrl(url);
  const group = detectGroup(new URL(startUrl));
  return withPage(headed, async (_context, page) => {
    const article = await readArticle(page, startUrl, group, logger, false);
    return {
      ...article,
      groupKey: group.key,
      groupName: group.label,
    };
  });
}

export async function archiveArticles(
  { url, output, limit = 10_000, delay = 3_000, headed = false, force = false },
  { logger = console } = {},
) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit は1以上の整数にしてください。");
  if (!Number.isInteger(delay) || delay < 1_000) throw new Error("--delay は1000以上にしてください。");
  const startUrl = normalizeArticleUrl(url);
  const group = detectGroup(new URL(startUrl));
  const outputRoot = resolveOutputPath(output);
  await mkdir(path.join(outputRoot, group.directory), { recursive: true });

  return withPage(headed, async (context, page) => {
    let currentUrl = startUrl;
    let expectedAuthor = "";
    let store;
    let processed = 0;
    const visited = new Set();

    try {
      while (currentUrl && processed < limit) {
        logger.log(`\n[${processed + 1}] ${currentUrl}`);
        const article = await readArticle(page, currentUrl, group, logger);

        markArticleVisited(visited, article.id);

        if (!expectedAuthor) {
          expectedAuthor = article.authorName;
          store = await openAuthorStore({ outputRoot, group, startUrl, authorName: expectedAuthor });
          logger.log(`グループ: ${group.label}`);
          logger.log(`投稿主体: ${expectedAuthor}`);
          logger.log(`保存先: ${store.directory}`);
        } else {
          assertSameAuthor(expectedAuthor, article.authorName);
        }

        const { pdfPath, mhtmlPath } = store.postPaths(article);
        await prepareArchiveView(page, {
          groupKey: group.key,
          title: article.title,
          authorName: article.authorName,
          date: article.date,
        });

        if (force || !(await exists(mhtmlPath))) {
          await saveMhtml(context, page, mhtmlPath);
          logger.log(`  MHTML保存: ${path.basename(mhtmlPath)}`);
        } else {
          logger.log("  MHTMLは保存済みのためスキップ");
        }

        if (force || !(await exists(pdfPath))) {
          await savePdf(page, pdfPath);
          logger.log(`  PDF保存:   ${path.basename(pdfPath)}`);
        } else {
          logger.log("  PDFは保存済みのためスキップ");
        }

        await store.savePost({
          id: article.id,
          title: article.title || "untitled",
          date: article.date,
          url: article.articleUrl,
          pdf: path.basename(pdfPath),
          mhtml: path.basename(mhtmlPath),
          images: article.images,
          checkedAt: new Date().toISOString(),
        });
        processed += 1;

        if (!article.previousUrl) {
          logger.log("\n最古のブログまで到達しました。");
          currentUrl = "";
          break;
        }
        currentUrl = normalizeArticleUrl(article.previousUrl, article.articleUrl, group.key);
        await sleep(delay);
      }

      if (processed === limit && currentUrl) {
        logger.log(`\n--limit ${limit} に到達したため終了しました。`);
      }
      logger.log(`\n完了: ${processed}件`);
      if (store) logger.log(`保存先: ${store.directory}`);
      return { processed, directory: store?.directory ?? null };
    } catch (error) {
      if (store) await store.saveError(currentUrl, error).catch(() => {});
      throw error;
    }
  });
}

// Web ジョブは選択済み URL を順に保存する。CLI の本文取得・整形・PDF/MHTML 生成を共用する。
export async function archiveWebArticles(
  { articles, output, author, maxBytes = 512 * 1024 * 1024, cacheResults = true },
  { logger = console, onProgress = async () => {} } = {},
) {
  if (!Array.isArray(articles) || articles.length < 1 || articles.length > 10) throw new Error("ブログは1回10件まで保存できます。");
  const outputRoot = resolveOutputPath(output);
  const startUrl = normalizeArticleUrl(articles[0].url);
  const group = detectGroup(new URL(startUrl));
  if (author?.group && author.group !== group.key) throw new Error("メンバーとブログのグループが一致しません。");
  const saved = [];
  let totalBytes = 0;
  return withPage(false, async (context, page) => {
    let authorName = author?.name ?? "";
    for (const [index, requested] of articles.entries()) {
      const requestedUrl = normalizeArticleUrl(requested.url, undefined, group.key);
      logger.log(`[${index + 1}/${articles.length}] ${requestedUrl}`);
      const article = await readArticle(page, requestedUrl, group, logger);
      if (article.articleUrl !== requestedUrl) throw new Error("ブログが別の URL へ移動しました。選択し直してください。");
      if (authorName && !sameAuthor(authorName, article.authorName)) {
        throw new Error(`選択した投稿者とブログの投稿者が一致しません: ${article.authorName}`);
      }
      authorName ||= article.authorName;
      const authorDirectory = path.join(group.directory, safeName(authorName));
      const articleDirectory = path.join(authorDirectory, [safeName(article.date, 20), article.id, safeName(article.title, 70)].join("_"));
      const destination = path.join(outputRoot, articleDirectory);
      await mkdir(destination, { recursive: true });
      const mhtmlPath = path.join(destination, "blog.mhtml");
      const pdfPath = path.join(destination, "blog.pdf");
      const cacheDirectory = path.join(path.dirname(outputRoot), "_blog-cache", group.key, safeName(author?.id ?? authorName), article.id);
      const cached = await readJson(path.join(cacheDirectory, "metadata.json"), null).catch(() => null);
      const cacheReady = cached?.url === article.articleUrl && cached?.authorId === (author?.id ?? null)
        && await exists(path.join(cacheDirectory, "blog.pdf")) && await exists(path.join(cacheDirectory, "blog.mhtml"));
      if (cacheReady) {
        for (const name of ["blog.pdf", "blog.mhtml"]) {
          await copyFile(path.join(cacheDirectory, name), path.join(destination, name));
        }
        logger.log(`  保存済みのブログを再利用: ${article.id}`);
      } else {
        await prepareArchiveView(page, { groupKey: group.key, title: article.title, authorName, date: article.date });
        if (!(await exists(mhtmlPath))) await saveMhtml(context, page, mhtmlPath);
      }
      totalBytes += (await stat(mhtmlPath)).size;
      if (totalBytes > maxBytes) throw new Error(`このジョブの出力容量が上限の${Math.floor(maxBytes / 1024 / 1024)} MBを超えました。`);
      if (!cacheReady && !(await exists(pdfPath))) await savePdf(page, pdfPath);
      totalBytes += (await stat(pdfPath)).size;
      if (totalBytes > maxBytes) throw new Error(`このジョブの出力容量が上限の${Math.floor(maxBytes / 1024 / 1024)} MBを超えました。`);
      const metadata = {
        id: article.id, title: article.title || "untitled", date: article.date,
        url: article.articleUrl, group: group.key, groupName: group.label,
        authorId: author?.id ?? null, authorName, authorType: author?.type ?? "other",
        pdf: "blog.pdf", mhtml: "blog.mhtml", images: article.images,
        checkedAt: new Date().toISOString(),
      };
      await writeJson(path.join(destination, "metadata.json"), metadata);
      totalBytes += (await stat(path.join(destination, "metadata.json"))).size;
      if (totalBytes > maxBytes) throw new Error(`このジョブの出力容量が上限の${Math.floor(maxBytes / 1024 / 1024)} MBを超えました。`);
      if (!cacheReady && cacheResults) {
        await mkdir(cacheDirectory, { recursive: true });
        await rm(path.join(cacheDirectory, "metadata.json"), { force: true });
        await copyFile(pdfPath, path.join(cacheDirectory, "blog.pdf"));
        await copyFile(mhtmlPath, path.join(cacheDirectory, "blog.mhtml"));
        await writeJson(path.join(cacheDirectory, "metadata.json"), metadata);
      }
      saved.push({ directory: articleDirectory, metadata });
      await onProgress(saved.length, totalBytes, saved.at(-1));
      if (index + 1 < articles.length) await sleep(1_000);
    }
    return { saved, totalBytes, authorName, groupName: group.directory };
  });
}
