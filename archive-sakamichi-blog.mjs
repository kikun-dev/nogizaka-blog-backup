import { chromium } from "playwright";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_LIMIT = 10_000;
const DEFAULT_DELAY_MS = 3_000;

const GROUPS = [
  {
    key: "nogizaka",
    directory: "Nogizaka",
    label: "乃木坂46",
    hosts: ["www.nogizaka46.com", "nogizaka46.com"],
    pathPattern: /^\/s\/n46\/diary\/detail\/\d+\/?$/,
    canonicalCd: "MEMBER",
    previousLabels: ["前の記事", "前へ"],
  },
  {
    key: "sakurazaka",
    directory: "Sakurazaka",
    label: "櫻坂46",
    hosts: ["sakurazaka46.com", "www.sakurazaka46.com"],
    pathPattern: /^\/s\/s46\/diary\/detail\/\d+\/?$/,
    canonicalCd: "blog",
    previousLabels: ["前へ", "前の記事"],
  },
  {
    key: "hinatazaka",
    directory: "Hinatazaka",
    label: "日向坂46",
    hosts: ["www.hinatazaka46.com", "hinatazaka46.com"],
    pathPattern: /^\/s\/official\/diary\/detail\/\d+\/?$/,
    canonicalCd: "member",
    previousLabels: ["前へ", "前の記事"],
  },
];

const GROUP_BY_KEY = new Map(
  GROUPS.map((group) => [group.key, group]),
);

function usage() {
  console.log(`
使い方:
  node archive-sakamichi-blog.mjs \\
    --url '最新ブログURL' \\
    --output '~/Documents/SakamichiBlogArchive'

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

function detectGroup(url) {
  const group = GROUPS.find(
    (candidate) =>
      candidate.hosts.includes(url.hostname) &&
      candidate.pathPattern.test(url.pathname),
  );

  if (!group) {
    throw new Error(
      [
        "対応している坂道公式ブログの記事URLではありません:",
        url.toString(),
      ].join(" "),
    );
  }

  return group;
}

function normalizeArticleUrl(
  rawUrl,
  baseUrl,
  expectedGroupKey,
) {
  const url = new URL(rawUrl, baseUrl);
  const group = detectGroup(url);

  if (
    expectedGroupKey &&
    group.key !== expectedGroupKey
  ) {
    throw new Error(
      [
        `別グループの記事へ移動したため停止します: ${group.label}`,
        `期待: ${GROUP_BY_KEY.get(expectedGroupKey)?.label}`,
      ].join(" "),
    );
  }

  // アクセスごとに変化する不要なパラメータを除去する。
  url.searchParams.delete("ima");

  url.searchParams.set("cd", group.canonicalCd);

  url.hash = "";

  return url.toString();
}

function resolveOutputPath(input) {
  const value = input.trim();

  if (!value) {
    throw new Error("保存先を指定してください。");
  }

  // C:\Users\name\... の形式にも対応する。
  const windowsPath = value.match(/^([A-Za-z]):[\\/](.*)$/);

  if (windowsPath) {
    const drive = windowsPath[1].toLowerCase();
    const rest = windowsPath[2].replaceAll("\\", "/");

    return path.resolve(`/mnt/${drive}/${rest}`);
  }

  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return path.resolve(homedir(), value.slice(2));
  }

  return path.resolve(value);
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
  const backup = `${destination}.bak`;

  try {
    await rename(source, destination);
  } catch (error) {
    if (
      error.code !== "EEXIST" &&
      error.code !== "EPERM"
    ) {
      throw error;
    }

    await rm(backup, {
      force: true,
    });

    let hasBackup = false;

    try {
      await rename(destination, backup);
      hasBackup = true;

      await rename(source, destination);
    } catch (replaceError) {
      if (hasBackup) {
        await rename(backup, destination).catch(() => {});
      }

      throw replaceError;
    } finally {
      await rm(backup, {
        force: true,
      });
    }
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

async function imageStats(page) {
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

async function prepareArchiveView(
  page,
  archiveMetadata,
) {
  await page.evaluate((metadata) => {
    const style = document.createElement("style");

    style.textContent = `
      html,
      body {
        width: 100% !important;
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
      }

      #js-wrap,
      #js-cont,
      .b--mn,
      .bd--mc,
      .bd--ctt,
      .bd--ctt__in,
      .bd--mn,
      .codex-archive-header,
      .bd--edit,
      .box-article,
      .p-blog-article,
      .c-blog-article__text {
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
        transform: none !important;
      }

      #js-wrap,
      #js-cont {
        position: static !important;
        width: 100% !important;
      }

      .b--gh,
      .b--ld,
      .b--ptb,
      .b--snv,
      .b--hm,
      .b--ph,
      .bd--aside,
      .bd--cmt,
      #comment,
      footer,
      header:not(.bd--hd),
      .drawer-nav,
      .head-logo,
      .com-hero,
      .com-hero-title,
      .blog-top,
      .blog-top .col-r,
      .blog-top .com-blog-circle,
      .blog-wdget-area,
      .blog-prof-r,
      .blog-foot-nav,
      .app-button,
      .app-title,
      .app-area,
      .box-app,
      .p-blog-profile,
      .p-blog-entry,
      .p-blog-face,
      .l-footer,
      .l-header,
      .c-header,
      .p-header,
      .b--ft__mn,
      .b--ec,
      .b--ev,
      .b--em,
      [class*="drawer"],
      [class*="hamburger"],
      #onetrust-banner-sdk,
      #onetrust-consent-sdk,
      #onetrust-pc-sdk,
      .onetrust-pc-dark-filter,
      .ot-sdk-container,
      .otFlat,
      [class*="onetrust"],
      [id*="onetrust"] {
        display: none !important;
      }

      .bd--ctt {
        padding-left: 0 !important;
        padding-right: 0 !important;
      }

      .bd--ctt__in,
      .bd--mn,
      .codex-archive-header,
      .bd--edit,
      .box-article,
      .p-blog-article,
      .c-blog-article__text {
        width: calc(100% - 48px) !important;
        max-width: 760px !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }

      .codex-archive-header {
        padding: 32px 0 28px !important;
      }

      .codex-archive-header h1 {
        margin: 0 !important;
        font-size: 2.4rem !important;
        line-height: 1.65 !important;
        letter-spacing: 0.08em !important;
        font-weight: 500 !important;
      }

      .codex-archive-header p {
        margin: 18px 0 0 !important;
        color: #6e6e73 !important;
        font-size: 1.2rem !important;
        letter-spacing: 0.08em !important;
      }

      .bd--edit img,
      .box-article img,
      .p-blog-article img,
      .c-blog-article__text img,
      .bd--edit picture,
      .box-article picture,
      .p-blog-article picture,
      .c-blog-article__text picture,
      .bd--edit figure,
      .box-article figure,
      .p-blog-article figure,
      .c-blog-article__text figure {
        max-width: 100% !important;
        height: auto !important;
        break-inside: avoid !important;
      }

      @media print {
        .bd--edit,
        .box-article,
        .p-blog-article,
        .c-blog-article__text {
          width: 100% !important;
          max-width: none !important;
        }
      }
    `;

    document.head.append(style);

    window.scrollTo(0, 0);

    document
      .querySelectorAll(".b--gh")
      .forEach((element) => {
        element.remove();
      });

    const removeElements = (selectors) => {
      document
        .querySelectorAll(selectors.join(","))
        .forEach((element) => {
          element.remove();
        });
    };

    const text = (value) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const hasVisibleArticleTitle = [
      ".bd--hd__ttl",
      ".c-blog-article__title",
      ".blog-title",
      "h1",
    ].some((selector) => {
      const element = document.querySelector(selector);

      if (!text(element?.textContent)) {
        return false;
      }

      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    if (
      metadata.groupKey === "nogizaka" &&
      metadata.title &&
      !hasVisibleArticleTitle
    ) {
      const article =
        document.querySelector(".bd--mn") ||
        document.querySelector(".bd--edit") ||
        document.querySelector(".bd--ctt__in");

      if (
        article &&
        !document.querySelector(".codex-archive-header")
      ) {
        const header = document.createElement("section");
        header.className = "codex-archive-header";

        const title = document.createElement("h1");
        title.textContent = metadata.title;
        header.append(title);

        const metaText = [
          metadata.memberName,
          metadata.date?.replaceAll("-", "."),
        ]
          .filter(Boolean)
          .join("  ");

        if (metaText) {
          const meta = document.createElement("p");
          meta.textContent = metaText;
          header.append(meta);
        }

        article.parentNode?.insertBefore(header, article);
      }
    }

    document
      .querySelectorAll(
        [
          "#onetrust-banner-sdk",
          "#onetrust-consent-sdk",
          "#onetrust-pc-sdk",
          ".onetrust-pc-dark-filter",
          ".ot-sdk-container",
          ".otFlat",
          "footer",
          "header:not(.bd--hd)",
          ".drawer-nav",
          ".head-logo",
          ".com-hero",
          ".com-hero-title",
          ".blog-top",
          ".blog-top .col-r",
          ".blog-top .com-blog-circle",
          ".blog-wdget-area",
          ".blog-prof-r",
          ".blog-foot-nav",
          ".bd--cmt",
          "#comment",
          ".app-button",
          ".app-area",
          ".box-app",
          ".p-blog-profile",
          ".p-blog-entry",
          ".p-blog-face",
          ".l-footer",
          ".l-header",
          ".c-header",
          ".p-header",
          ".b--ft__mn",
          ".b--ec",
          ".b--ev",
          ".b--em",
          "[class*='drawer']",
          "[class*='hamburger']",
          "[class*='onetrust']",
          "[id*='onetrust']",
        ].join(","),
      )
      .forEach((element) => {
        element.remove();
      });

    document.querySelectorAll(".app-title").forEach((element) => {
      const appBanner = element.closest(".app-button");

      (appBanner ?? element).remove();
    });

    document
      .querySelectorAll(".p-blog-entry__group")
      .forEach((element) => {
        const subtitle = text(
          element.querySelector(".c-blog-entry_area__subtitle")
            ?.textContent,
        );

        if (/^(乃木坂46|櫻坂46|日向坂46)の?$/.test(subtitle)) {
          element.remove();
        }
      });

    removeElements([
      ".bd--cmt__carea",
      ".bd--cmt__list",
      ".bd--cmt__pg",
    ]);

    [
      "#js-wrap",
      "#js-cont",
      ".js-st",
      ".js-st-win",
    ].forEach((selector) => {
      document
        .querySelectorAll(selector)
        .forEach((element) => {
          element.style.transform = "none";
          element.style.height = "auto";
          element.style.minHeight = "0";
          element.style.overflow = "visible";
        });
    });
  }, archiveMetadata);

  await page.waitForTimeout(500);
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

async function getMetadata(page, group) {
  return page.evaluate(({ previousLabels }) => {
    const text = (value) =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const anchors = [
      ...document.querySelectorAll("a[href]"),
    ];

    const removeBlogSuffix = (value) =>
      text(value)
        .replace(/\s*公式ブログ\s*/g, "")
        .trim();

    const authorLink = anchors.find((anchor) => {
      const anchorText = text(anchor.textContent);

      return (
        anchorText.includes("公式ブログ") &&
        anchor.href.includes("/diary/")
      );
    });

    const blogHeading = [
      ...document.querySelectorAll("h1,h2,h3,a,span,p,div"),
    ].find((element) => {
      const value = text(element.textContent);

      return (
        value.includes("公式ブログ") &&
        value.length <= 80
      );
    });

    const previous =
      anchors.find((anchor) =>
        previousLabels.includes(text(anchor.textContent)),
      ) ||
      anchors.find(
        (anchor) =>
          anchor.href.includes("/diary/detail/") &&
          anchor.closest(
            ".c-pager__item--prev, .pager-prev, [class*='prev']",
          ),
      );

    const articleDateText =
      [
        ".c-blog-article__date",
        ".blog-foot .date",
        ".bd--hd__date",
        "time",
      ]
        .map((selector) =>
          text(
            document.querySelector(selector)
              ?.textContent,
          ),
        )
        .find(Boolean) || document.body.innerText;

    const dateMatch = articleDateText.match(
      /\b(20\d{2})[./年](\d{1,2})[./月](\d{1,2})(?:日)?(?:\s+\d{1,2}:\d{2})?/,
    );

    const title =
      text(document.querySelector("h1")?.textContent) ||
      text(
        document.querySelector(".c-blog-article__title")
          ?.textContent,
      );

    const memberName =
      text(
        document.querySelector(".c-blog-article__name")
          ?.textContent,
      ) ||
      removeBlogSuffix(authorLink?.textContent) ||
      removeBlogSuffix(blogHeading?.textContent).replace(
        /^OFFICIAL BLOG\s*/,
        "",
      );

    return {
      title,
      memberName,

      date: dateMatch
        ? [
            dateMatch[1],
            dateMatch[2].padStart(2, "0"),
            dateMatch[3].padStart(2, "0"),
          ].join("-")
        : "date-unknown",

      previousUrl: previous?.href ?? null,
    };
  }, {
    previousLabels: group.previousLabels,
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

  const group = detectGroup(
    new URL(options.url),
  );

  const startUrl =
    normalizeArticleUrl(
      options.url,
      undefined,
      group.key,
    );

  const outputRoot =
    path.join(
      resolveOutputPath(options.output),
      group.directory,
    );

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
        await getMetadata(page, group);

      const articleUrl =
        normalizeArticleUrl(
          page.url(),
          undefined,
          group.key,
        );

      const articleId =
        articleUrl.match(
          /\/detail\/(\d+)/,
        )?.[1];

      if (
        !articleId ||
        !metadata.memberName
      ) {
        throw new Error(
          "記事ID・メンバー名の取得に失敗しました。",
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
            group: group.key,
            groupName: group.label,
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
          `グループ: ${group.label}`,
        );

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

      await prepareArchiveView(page, {
        groupKey: group.key,
        title: metadata.title,
        memberName: metadata.memberName,
        date: metadata.date,
      });

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
        title: metadata.title || "untitled",
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

      index.group = group.key;

      index.groupName = group.label;

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
          group.key,
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
