import { access, readFile, rename, rm, writeFile } from "node:fs/promises";

export async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback) {
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

export async function replaceFile(source, destination) {
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

export async function readJsonArray(filePath) {
  try {
    return await readJson(filePath, []);
  } catch (error) {
    console.warn(
      `警告: エラー履歴を読み込めませんでした: ${error.message}`,
    );

    return [];
  }
}

export async function writeJson(filePath, value) {
  await writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}
