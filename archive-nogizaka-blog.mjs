import { chromium } from "playwright";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIMIT = 10_000;
const DEFAULT_DELAY_MS = 3_000;

function usage() {
  console.log(`
使い方:
  node archive-nogizaka-blog.mjs \\
    --url '最新ブログURL' \\
    --output '/mnt/c/Users/Windowsユーザー名/Documents/NogizakaBlogArchive'

オプション:
  --limit 3     3記事だけ処理する
  --delay 5000  記事間を5秒空ける（既定: 3000ms）
  --headed      ブラウザ画面を表示する
  --force       既存ファイルを上書きする
`);
}

function parseArgs(argv) {
  const options = {
    url: "",
    output: "",
    limit: DEFAULT_LIMIT,
    delay: DEFAULT_DELAY_MS,
    headed: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--url":
        options.url = argv[++i] ?? "";
        break;

      case "--output":
        options.output = argv[++i] ?? "";
        break;

      case "--limit":
        options.limit = Number.parseInt(argv[++i] ?? "", 10);
        break;

      case "--delay":
        options.delay = Number.parseInt(argv[++i] ?? "", 10);
        break;

      case "--headed":
        options.headed = true;
        break;

      case "--force":
        options.force = true;
        break;

      case "--help":
      case "-h":
        usage();
        process.exit(0);

      default:
        throw new Error(`不明なオプションです: ${argv[i]}`);
    }
  }

  if (!options.url || !options.output) {
    usage();
    throw new Error("--url と --output は必須です。");
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit は1以上の整数にしてください。");
  }

  if (!Number.isInteger(options.delay) || options.delay < 1_000) {
    throw new Error("--delay は1000以上にしてください。");
  }

  return options;
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function normalizeArticleUrl(rawUrl, baseUrl) {
  const url = new URL(rawUrl, baseUrl);

  if (
    url.hostname !== "www.nogizaka46.com" ||
    !/^\/s\/n46\/diary\/detail\/\d+\/?$/.test(url.pathname)
  ) {
    throw new Error(
      `乃木坂46公式ブログの記事URLではありません: ${url}`,
    );
  }

  // アクセスごとに変化する不要なパラメータを除去する。
  url.searchParams.delete("ima");

  // メンバー別の記事として開く。
  url.searchParams.set("cd", "MEMBER");

  url.hash = "";

  return url.toString();
}

function toWslWindowsPath(input) {
  const value = input.trim();

  // C:\Users\name\... の形式にも対応する。
  const windowsPath = value.match(/^([A-Za-z]):[\\/](.*)$/);

  if (windowsPath) {
    const drive = windowsPath[1].toLowerCase();
    const rest = windowsPath[2].replaceAll("\\", "/");

    return path.resolve(`/mnt/${drive}/${rest}`);
  }

  // WSL形式のWindowsパス。
  if (/^\/mnt\/[A-Za-z](?:\/|$)/.test(value)) {
    return path.resolve(value);
  }

  throw new Error(
    [
      "保存先はWindows側を指定してください。",
      "例: /mnt/c/Users/name/Documents/NogizakaBlogArchive",
    ].join(" "),
  );
}

function safeName(value, maxLength = 100) {
  const name = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, maxLength);

  return name || "untitled";
}

function sameMember(left, right) {
  const normalize = (value) =>
    value.normalize("NFKC").replace(/\s+/g, "");

  return normalize(left) === normalize(right);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw new Error(
      `JSONファイルの読み込みに失敗しました: ${filePath}: ${error.message}`,
    );
  }
}

async function replaceFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (
      error.code !== "EEXIST" &&
      error.code !== "EPERM"
    ) {
      throw error;
    }

    await rm(destination, {
      force: true,
    });

    await rename(source, destination);
  }
}

async function readJsonArray(filePath) {
  try {
    return await readJson(filePath, []);
  } catch (error) {
    console.warn(
      `警告: エラー履歴を読み込めませんでした: ${error.message}`,
    );

    return [];
  }
}

async function writeJson(filePath, value) {
  await writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function scrollAndWaitForImages(page) {
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
      () =>
        [...document.images]
          .filter((image) =>
            [
              image.currentSrc,
              image.src,
              image.dataset.src,
              image.dataset.original,
            ].some((source) =>
              source?.includes("/files/46/diary/"),
            ),
          )
          .every(
            (image) =>
              image.complete && image.naturalWidth > 0,
          ),
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

async function imageStats(page) {
  return page.evaluate(() => {
    const images = [...document.images]
      .map((image) => {
        const source =
          [
            image.currentSrc,
            image.src,
            image.dataset.src,
            image.dataset.original,
          ].find((candidate) =>
            candidate?.includes("/files/46/diary/"),
          ) || "";

        return {
          source,
          loaded:
            image.complete && image.naturalWidth > 0,
        };
      })
      .filter(({ source }) =>
        source.includes("/files/46/diary/"),
      );

    return {
      detected: images.length,
      loaded: images.filter(({ loaded }) => loaded).length,
      failed: images.filter(({ loaded }) => !loaded).length,
    };
  });
}

async function openArticle(page, url) {
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

      await page.locator("h1").first().waitFor({
        state: "visible",
        timeout: 30_000,
      });

      await page
        .waitForLoadState("networkidle", {
          timeout: 15_000,
        })
        .catch(() => {});

      await scrollAndWaitForImages(page);

      const stats = await imageStats(page);

      if (stats.failed > 0) {
        throw new Error(
          `本文画像の読み込み失敗: ${stats.failed}/${stats.detected}`,
        );
      }

      return stats;
    } catch (error) {
      lastError = error;

      console.warn(
        `  読み込み再試行 ${attempt}/3: ${error.message}`,
      );

      if (attempt < 3) {
        await sleep(3_000 * attempt);
      }
    }
  }

  throw lastError;
}

async function getMetadata(page) {
  return page.evaluate(() => {
    const text = (value) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const anchors = [
      ...document.querySelectorAll("a[href]"),
    ];

    const author = anchors.find((anchor) => {
      const anchorText = text(anchor.textContent);

      return (
        anchorText.includes("公式ブログ") &&
        anchor.href.includes("/diary/")
      );
    });

    const previous = anchors.find(
      (anchor) =>
        text(anchor.textContent) === "前の記事",
    );

    const dateMatch = document.body.innerText.match(
      /\b(20\d{2})[./年](\d{1,2})[./月](\d{1,2})(?:日)?(?:\s+\d{1,2}:\d{2})?/,
    );

    return {
      title: text(
        document.querySelector("h1")?.textContent,
      ),

      memberName: text(author?.textContent).replace(
        /\s*公式ブログ\s*/g,
        "",
      ),

      date: dateMatch
        ? [
            dateMatch[1],
            dateMatch[2].padStart(2, "0"),
            dateMatch[3].padStart(2, "0"),
          ].join("-")
        : "date-unknown",

      previousUrl: previous?.href ?? null,
    };
  });
}

async function saveMhtml(
  context,
  page,
  destination,
) {
  const temporary = `${destination}.part`;

  const session =
    await context.newCDPSession(page);

  try {
    const { data } = await session.send(
      "Page.captureSnapshot",
      {
        format: "mhtml",
      },
    );

    await writeFile(
      temporary,
      data,
      "utf8",
    );

    await replaceFile(
      temporary,
      destination,
    );
  } finally {
    await session.detach().catch(() => {});

    await rm(temporary, {
      force: true,
    });
  }
}

async function savePdf(
  page,
  destination,
) {
  const temporary = `${destination}.part`;

  try {
    // 通常のブラウザ表示に近いCSSを使用する。
    await page.emulateMedia({
      media: "screen",
    });

    // PDF内で画像が横にはみ出しにくくする。
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        img,
        picture,
        figure {
          max-width: 100% !important;
          height: auto !important;
          break-inside: avoid !important;
        }
      `,
    });

    await page.pdf({
      path: temporary,
      format: "A4",
      printBackground: true,
      margin: {
        top: "12mm",
        right: "10mm",
        bottom: "12mm",
        left: "10mm",
      },
    });

    await replaceFile(
      temporary,
      destination,
    );
  } finally {
    await rm(temporary, {
      force: true,
    });
  }
}

async function main() {
  const options = parseArgs(
    process.argv.slice(2),
  );

  const startUrl =
    normalizeArticleUrl(options.url);

  const outputRoot =
    toWslWindowsPath(options.output);

  await mkdir(outputRoot, {
    recursive: true,
  });

  const browser = await chromium.launch({
    headless: !options.headed,
  });

  const context =
    await browser.newContext({
      locale: "ja-JP",
      viewport: {
        width: 1280,
        height: 900,
      },
    });

  const page = await context.newPage();

  let currentUrl = startUrl;
  let expectedMember = "";
  let memberDirectory = "";
  let indexPath = "";
  let index;
  let processed = 0;

  const visited = new Set();

  try {
    while (
      currentUrl &&
      processed < options.limit
    ) {
      console.log(
        `\n[${processed + 1}] ${currentUrl}`,
      );

      const images =
        await openArticle(
          page,
          currentUrl,
        );

      const metadata =
        await getMetadata(page);

      const articleUrl =
        normalizeArticleUrl(page.url());

      const articleId =
        articleUrl.match(
          /\/detail\/(\d+)/,
        )?.[1];

      if (
        !articleId ||
        !metadata.title ||
        !metadata.memberName
      ) {
        throw new Error(
          "記事ID・タイトル・メンバー名の取得に失敗しました。",
        );
      }

      if (visited.has(articleId)) {
        throw new Error(
          `同じ記事に戻ったため停止します: ${articleId}`,
        );
      }

      visited.add(articleId);

      // 最初の記事からメンバー名と保存先を決定する。
      if (!expectedMember) {
        expectedMember =
          metadata.memberName;

        memberDirectory = path.join(
          outputRoot,
          safeName(expectedMember),
        );

        indexPath = path.join(
          memberDirectory,
          "index.json",
        );

        // フォルダがあればそのまま利用し、
        // なければ新規作成する。
        await mkdir(memberDirectory, {
          recursive: true,
        });

        index = await readJson(
          indexPath,
          {
            memberName: expectedMember,
            startUrl,
            posts: [],
          },
        );

        if (
          index.memberName &&
          !sameMember(
            index.memberName,
            expectedMember,
          )
        ) {
          throw new Error(
            `保存先は別メンバー用です: ${index.memberName}`,
          );
        }

        console.log(
          `メンバー: ${expectedMember}`,
        );

        console.log(
          `保存先: ${memberDirectory}`,
        );
      } else if (
        !sameMember(
          metadata.memberName,
          expectedMember,
        )
      ) {
        throw new Error(
          `別メンバーの記事へ移動したため停止します: ${metadata.memberName}`,
        );
      }

      const baseName = [
        metadata.date,
        articleId,
        safeName(
          metadata.title,
          70,
        ),
      ].join("_");

      const pdfPath = path.join(
        memberDirectory,
        `${baseName}.pdf`,
      );

      const mhtmlPath = path.join(
        memberDirectory,
        `${baseName}.mhtml`,
      );

      // 通常表示の状態を先にMHTMLとして保存する。
      if (
        options.force ||
        !(await exists(mhtmlPath))
      ) {
        await saveMhtml(
          context,
          page,
          mhtmlPath,
        );

        console.log(
          `  MHTML保存: ${path.basename(mhtmlPath)}`,
        );
      } else {
        console.log(
          "  MHTMLは保存済みのためスキップ",
        );
      }

      if (
        options.force ||
        !(await exists(pdfPath))
      ) {
        await savePdf(
          page,
          pdfPath,
        );

        console.log(
          `  PDF保存:   ${path.basename(pdfPath)}`,
        );
      } else {
        console.log(
          "  PDFは保存済みのためスキップ",
        );
      }

      const record = {
        id: articleId,
        title: metadata.title,
        date: metadata.date,
        url: articleUrl,
        pdf: path.basename(pdfPath),
        mhtml: path.basename(mhtmlPath),
        images,
        checkedAt:
          new Date().toISOString(),
      };

      const position =
        index.posts.findIndex(
          ({ id }) => id === articleId,
        );

      if (position >= 0) {
        index.posts[position] =
          record;
      } else {
        index.posts.push(record);
      }

      index.memberName =
        expectedMember;

      index.updatedAt =
        new Date().toISOString();

      await writeJson(
        indexPath,
        index,
      );

      processed += 1;

      if (!metadata.previousUrl) {
        console.log(
          "\n最古の記事まで到達しました。",
        );

        currentUrl = "";
        break;
      }

      currentUrl =
        normalizeArticleUrl(
          metadata.previousUrl,
          articleUrl,
        );

      await sleep(options.delay);
    }

    if (
      processed === options.limit &&
      currentUrl
    ) {
      console.log(
        `\n--limit ${options.limit} に到達したため終了しました。`,
      );
    }

    console.log(
      `\n完了: ${processed}件`,
    );

    if (memberDirectory) {
      console.log(
        `保存先: ${memberDirectory}`,
      );
    }
  } catch (error) {
    // エラーが起きた記事を記録する。
    if (memberDirectory) {
      const errorsPath = path.join(
        memberDirectory,
        "errors.json",
      );

      const errors =
        await readJsonArray(errorsPath);

      errors.push({
        url: currentUrl,
        message: error.message,
        at: new Date().toISOString(),
      });

      await writeJson(
        errorsPath,
        errors,
      ).catch(() => {});
    }

    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(
    `\nエラー: ${error.message}`,
  );

  console.error(
    "同じコマンドを再実行すると、保存済みファイルを飛ばして続行できます。",
  );

  process.exitCode = 1;
});
