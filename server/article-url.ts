const articlePaths = new Map([
  ["nogizaka46.com", /^\/s\/n46\/diary\/detail\/\d+\/?$/],
  ["www.nogizaka46.com", /^\/s\/n46\/diary\/detail\/\d+\/?$/],
  ["sakurazaka46.com", /^\/s\/s46\/diary\/detail\/\d+\/?$/],
  ["www.sakurazaka46.com", /^\/s\/s46\/diary\/detail\/\d+\/?$/],
  ["hinatazaka46.com", /^\/s\/official\/diary\/detail\/\d+\/?$/],
  ["www.hinatazaka46.com", /^\/s\/official\/diary\/detail\/\d+\/?$/],
]);

export function parseArticleUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("公式ブログの個別記事URLを入力してください。");
  }

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("URLの形式を確認してください。");
  }

  const pathPattern = articlePaths.get(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !pathPattern?.test(url.pathname)
  ) {
    throw new Error("乃木坂46・櫻坂46・日向坂46の個別記事URLを指定してください。");
  }

  return url.toString();
}
