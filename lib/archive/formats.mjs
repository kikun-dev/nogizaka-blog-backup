import { rm, writeFile } from "node:fs/promises";
import { replaceFile } from "./storage.mjs";

export async function prepareArchiveView(
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
          metadata.authorName,
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

export async function saveMhtml(
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

export async function savePdf(
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
