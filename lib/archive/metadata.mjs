export async function getMetadata(page, group) {
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

    const authorName =
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
      authorName,

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
