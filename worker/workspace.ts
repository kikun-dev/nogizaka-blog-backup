import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
// Public jobs are bounded to a small number of articles. Keep a generous grace
// period for a live PID, while still collecting directories after PID reuse.
export const ORPHAN_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function workRoot(): string {
  const configured = process.env.WORKER_OUTPUT_ROOT;
  if (!configured || !path.isAbsolute(configured)) throw new Error("WORKER_OUTPUT_ROOT に絶対パスを設定してください。");
  return path.join(configured, "sakamichi-worker");
}

export async function prepareWork(): Promise<string> {
  const root = workRoot();
  await mkdir(root, { recursive: true });
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < MIN_FREE_BYTES) throw new Error("ワーカーの空き容量が2 GB未満です。保存先を確認してください。");
  return mkdtemp(path.join(root, `job-${process.pid}-`));
}

export async function cleanOrphanWork(root = workRoot(), now = Date.now()): Promise<void> {
  await mkdir(root, { recursive: true });
  // Older public worker versions created an unbounded cache outside job-*.
  await rm(path.join(root, "_blog-cache"), { recursive: true, force: true });
  for (const name of await readdir(root)) {
    const match = /^job-(\d+)-[A-Za-z0-9]+$/.exec(name);
    if (!match) continue;
    const directory = path.join(root, name);
    const info = await stat(directory);
    if (!info.isDirectory()) continue;
    let ownerAlive = true;
    try { process.kill(Number(match[1]), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") ownerAlive = false;
    }
    if (!ownerAlive || now - info.mtimeMs > ORPHAN_MAX_AGE_MS) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
