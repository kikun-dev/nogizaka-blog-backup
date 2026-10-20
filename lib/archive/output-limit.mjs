import { rm } from "node:fs/promises";

export class ArchiveOutputLimitError extends Error {
  constructor(maxBytes) {
    super(`このジョブの出力容量が上限の${Math.floor(maxBytes / 1024 / 1024)} MBを超えました。`);
    this.name = "ArchiveOutputLimitError";
  }
}

export async function enforceArchiveOutputLimit(totalBytes, maxBytes, destination) {
  if (totalBytes <= maxBytes) return;
  await rm(destination, { recursive: true, force: true });
  throw new ArchiveOutputLimitError(maxBytes);
}
