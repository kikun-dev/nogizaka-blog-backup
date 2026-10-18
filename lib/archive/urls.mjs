import { GROUPS, GROUP_BY_KEY } from "./groups.mjs";

export class UserInputError extends Error {
  showRetryHint = false;
}

export function detectGroup(url) {
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new UserInputError("HTTPS の公式ブログの個別URLを指定してください。");
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
          "一覧ページではなく、保存したいブログを1件開いた個別URLを指定してください。",
          `ブログの個別URLの例: ${hostGroup.articleUrlExample}`,
        ].join(" "),
      );
    }

    throw new UserInputError(
      [
        "対応している坂道公式ブログの個別URLではありません:",
        url.toString(),
        "保存したいブログを1件開いた個別URLを指定してください。",
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
        `別グループのブログへ移動したため停止します: ${group.label}`,
        `期待: ${GROUP_BY_KEY.get(expectedGroupKey)?.label}`,
      ].join(" "),
    );
  }

  // アクセスごとに変化する不要なパラメータを除去する。
  url.searchParams.delete("ima");

  // staff・期別ブログなどの個別ページが持つ投稿主体の区分を保つ。
  if (!url.searchParams.has("cd")) {
    url.searchParams.set("cd", group.canonicalCd);
  }

  url.hash = "";

  return url.toString();
}
