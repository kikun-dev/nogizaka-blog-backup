import type { LocalJob } from "../server/job-store";

export const RECENT_PUBLIC_JOB_KEY = "sakamichi-public-recent-job";
const RESULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RecentJobStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export function clearRecentPublicJob(storage: RecentJobStorage): void {
  try { storage.removeItem(RECENT_PUBLIC_JOB_KEY); } catch { /* Storage may be disabled. */ }
}

export function saveRecentPublicJob(storage: RecentJobStorage, id: string): void {
  if (!UUID.test(id)) return;
  try { storage.setItem(RECENT_PUBLIC_JOB_KEY, id); } catch { /* Storage may be disabled. */ }
}

function readRecentPublicJob(storage: RecentJobStorage): string | null {
  let id: string | null;
  try { id = storage.getItem(RECENT_PUBLIC_JOB_KEY); } catch { return null; }
  if (id && !UUID.test(id)) {
    clearRecentPublicJob(storage);
    return null;
  }
  return id;
}

export type RestoredPublicJob = { authenticated: boolean; job: LocalJob | null; workerOffline: boolean };

export async function restoreRecentPublicJob(storage: RecentJobStorage, fetcher: Fetcher,
  now = Date.now()): Promise<RestoredPublicJob> {
  const sessionResponse = await fetcher("/api/access-session", { cache: "no-store" });
  if (!sessionResponse.ok) throw new Error("アクセス状態を確認できませんでした。");
  const session = await sessionResponse.json() as { authenticated?: boolean };
  if (!session.authenticated) {
    clearRecentPublicJob(storage);
    return { authenticated: false, job: null, workerOffline: false };
  }

  const id = readRecentPublicJob(storage);
  if (!id) return { authenticated: true, job: null, workerOffline: false };
  const response = await fetcher(`/api/jobs/${id}`, { cache: "no-store" });
  if (response.status === 401 || response.status === 404) {
    clearRecentPublicJob(storage);
    return { authenticated: response.status !== 401, job: null, workerOffline: false };
  }
  if (!response.ok) throw new Error("前回の結果を確認できませんでした。再読み込みしてください。");
  const data = await response.json() as { job?: LocalJob; workerOffline?: boolean };
  const job = data.job;
  if (!job || job.id !== id || (job.kind !== "blog" && job.kind !== "photos")
    || !["queued", "running", "succeeded", "partial", "failed"].includes(job.status)) {
    clearRecentPublicJob(storage);
    return { authenticated: true, job: null, workerOffline: false };
  }
  if (["succeeded", "partial", "failed"].includes(job.status)
    && (!Number.isFinite(Date.parse(job.updatedAt)) || Date.parse(job.updatedAt) + RESULT_LIFETIME_MS <= now)) {
    clearRecentPublicJob(storage);
    return { authenticated: true, job: null, workerOffline: false };
  }
  return { authenticated: true, job, workerOffline: Boolean(data.workerOffline) };
}
