export async function scrollAndWaitForImages(page) {
  // 遅延読み込み画像を表示させるため、
  // ページの一番下まで少しずつスクロールする。
  await page.evaluate(async () => {
    const wait = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    const step = Math.max(
      500,
      Math.floor(window.innerHeight * 0.8),
    );

    for (
      let y = 0;
      y <= document.documentElement.scrollHeight;
      y += step
    ) {
      window.scrollTo(0, y);
      await wait(120);
    }

    window.scrollTo(
      0,
      document.documentElement.scrollHeight,
    );

    await wait(1_000);
  });

  // ブログ本文の画像が読み込まれるまで待つ。
  await page
    .waitForFunction(
      () => {
        const root =
          document.querySelector(".bd--edit") ??
          document.querySelector(".box-article") ??
          document.querySelector(".c-blog-article__text") ??
          document.querySelector(".p-blog-article") ??
          document.querySelector("article") ??
          document.body;

        return [...root.querySelectorAll("img")].every(
          (image) =>
            image.complete && image.naturalWidth > 0,
        );
      },
      undefined,
      {
        timeout: 30_000,
      },
    )
    .catch(() => {});

  // Webフォントの読み込み完了を待つ。
  await page.evaluate(async () => {
    await document.fonts?.ready;
    window.scrollTo(0, 0);
  });

  await page.waitForTimeout(500);
}

export async function imageStats(page) {
  return page.evaluate(() => {
    const root =
      document.querySelector(".bd--edit") ??
      document.querySelector(".box-article") ??
      document.querySelector(".c-blog-article__text") ??
      document.querySelector(".p-blog-article") ??
      document.querySelector("article") ??
      document.body;

    const images = [...root.querySelectorAll("img")]
      .map((image) => {
        const source =
          [
            image.currentSrc,
            image.src,
            image.dataset.src,
            image.dataset.original,
          ].find((candidate) =>
            Boolean(candidate),
          ) || "";

        return {
          source,
          loaded:
            image.complete && image.naturalWidth > 0,
        };
      })
      .filter(({ source }) => source);

    return {
      detected: images.length,
      loaded: images.filter(({ loaded }) => loaded).length,
      failed: images.filter(({ loaded }) => !loaded).length,
    };
  });
}
