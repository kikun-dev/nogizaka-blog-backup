import { mkdir } from "node:fs/promises";
import path from "node:path";
import { safeName, sameAuthor } from "./paths.mjs";
import { readJson, readJsonArray, writeJson } from "./storage.mjs";

export async function openAuthorStore({ outputRoot, group, startUrl, authorName }) {
  const directory = path.join(outputRoot, group.directory, safeName(authorName));
  const indexPath = path.join(directory, "index.json");
  await mkdir(directory, { recursive: true });

  const index = await readJson(indexPath, {
    authorName,
    group: group.key,
    groupName: group.label,
    startUrl,
    posts: [],
  });
  const existingAuthor = index.authorName ?? index.memberName;
  if (existingAuthor && !sameAuthor(existingAuthor, authorName)) {
    throw new Error(`保存先は別の投稿主体用です: ${existingAuthor}`);
  }
  if (index.group && index.group !== group.key) {
    throw new Error(`保存先は別グループ用です: ${index.group}`);
  }
  if (!Array.isArray(index.posts)) {
    throw new Error(`索引の posts が不正です: ${indexPath}`);
  }

  index.authorName = authorName;
  delete index.memberName;
  index.group = group.key;
  index.groupName = group.label;

  return {
    directory,
    postPaths({ id, date, title }) {
      const baseName = [date, id, safeName(title, 70)].join("_");
      return {
        pdfPath: path.join(directory, `${baseName}.pdf`),
        mhtmlPath: path.join(directory, `${baseName}.mhtml`),
      };
    },
    async savePost(record) {
      const position = index.posts.findIndex(({ id }) => id === record.id);
      if (position >= 0) index.posts[position] = record;
      else index.posts.push(record);
      index.updatedAt = new Date().toISOString();
      await writeJson(indexPath, index);
    },
    async saveError(url, error) {
      const errorsPath = path.join(directory, "errors.json");
      const errors = await readJsonArray(errorsPath);
      errors.push({
        url,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      });
      await writeJson(errorsPath, errors);
    },
  };
}
