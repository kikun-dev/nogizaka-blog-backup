import { GROUPS, GROUP_BY_KEY } from "./groups.mjs";

export class UserInputError extends Error {
  showRetryHint = false;
}

export function detectGroup(url) {
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new UserInputError("HTTPS の公式ブログ記事URLを指定してください。");
  }
  const group = GROUPS.find(
    (candidate) =>
      candidate.hosts.includes(url.hostname) &&
      candidate.pathPattern.test(url.pathname),
  );

  if (!group) {
    const hostGroup = GROUPS.find((candidate) =>
      candidate.hosts.includes(url.hostname),
    );

    if (
      hostGroup?.memberListPattern?.test(url.pathname)
    ) {
      throw new UserInputError(
        [
          `${hostGroup.label}のメンバー別ブログ一覧ページが指定されています。`,
          "一覧ページではなく、保存したい記事を1つ開いた個別記事URLを指定してください。",
          `個別記事URLの例: ${hostGroup.articleUrlExample}`,
        ].join(" "),
      );
    }

    throw new UserInputError(
      [
        "対応している坂道公式ブログの記事URLではありません:",
        url.toString(),
        "保存したい記事を1つ開いた個別記事URLを指定してください。",
      ].join(" "),
    );
  }

  return group;
}

export function normalizeArticleUrl(
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

  // staff・期別ブログなどの記事が持つ投稿主体の区分を保つ。
  if (!url.searchParams.has("cd")) {
    url.searchParams.set("cd", group.canonicalCd);
  }

  url.hash = "";

  return url.toString();
}
