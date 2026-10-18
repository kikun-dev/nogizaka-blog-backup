import { imageStats, scrollAndWaitForImages } from "./images.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openArticle(page, url, {
  warn = console.warn,
  wait = sleep,
  loadImages = scrollAndWaitForImages,
  countImages = imageStats,
  verifyImages = true,
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      if (response && !response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }

      await page
        .locator(
          [
            ".bd--edit",
            ".box-article",
            ".c-blog-article__text",
            ".p-blog-article",
            ".blog-foot",
            ".c-blog-article__date",
          ].join(","),
        )
        .first()
        .waitFor({
          state: "visible",
          timeout: 30_000,
        });

      await page
        .waitForLoadState("networkidle", {
          timeout: 15_000,
        })
        .catch(() => {});

      if (verifyImages) await loadImages(page);

      const stats = await countImages(page);

      if (verifyImages && stats.failed > 0) {
        throw new Error(
          `本文画像の読み込み失敗: ${stats.failed}/${stats.detected}`,
        );
      }

      return stats;
    } catch (error) {
      lastError = error;

      warn(
        `  読み込み再試行 ${attempt}/3: ${error.message}`,
      );

      if (attempt < 3) {
        await wait(3_000 * attempt);
      }
    }
  }

  throw lastError;
}
