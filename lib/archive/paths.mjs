import { homedir } from "node:os";
import path from "node:path";

export function resolveOutputPath(input) {
  const value = input.trim();

  if (!value) {
    throw new Error("保存先を指定してください。");
  }

  // C:\Users\name\... の形式にも対応する。
  const windowsPath = value.match(/^([A-Za-z]):[\\/](.*)$/);

  if (windowsPath) {
    if (process.platform === "win32") {
      return path.resolve(value);
    }

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

export function safeName(value, maxLength = 100) {
  const name = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, maxLength);

  return name || "untitled";
}

export function sameAuthor(left, right) {
  const normalize = (value) =>
    value.normalize("NFKC").replace(/\s+/g, "");

  return normalize(left) === normalize(right);
}
