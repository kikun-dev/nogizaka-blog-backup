import { normalizeArticleUrl } from "../lib/archive/urls.mjs";

export function parseArticleUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("公式ブログの個別URLを入力してください。");
  }

  try {
    return normalizeArticleUrl(input.trim());
  } catch {
    throw new Error("乃木坂46・櫻坂46・日向坂46のブログの個別URLを指定してください。");
  }
}
