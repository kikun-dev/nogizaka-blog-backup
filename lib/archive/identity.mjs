import { sameAuthor } from "./paths.mjs";

export function markArticleVisited(visited, id) {
  if (visited.has(id)) throw new Error(`同じ記事に戻ったため停止します: ${id}`);
  visited.add(id);
}

export function assertSameAuthor(expected, actual) {
  if (!sameAuthor(expected, actual)) {
    throw new Error(`別の投稿主体の記事へ移動したため停止します: ${actual}`);
  }
}
