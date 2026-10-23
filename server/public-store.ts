import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BlogArticle, BlogAuthor } from "@/lib/catalog/types";
import type { SelectionRequest } from "@/lib/selection";
import type { LocalJob } from "./job-store";

export type PublicRequest =
  | { selection: SelectionRequest }
  | { selection: SelectionRequest; confirmedArticles: BlogArticle[]; confirmedAuthor: BlogAuthor }
  | { retryArticles: NonNullable<LocalJob["requestedArticles"]>; author: BlogAuthor };

export type PublicJobRow = {
  id: string;
  owner_session_id: string;
  kind: "blog" | "photos";
  status: LocalJob["status"];
  request: PublicRequest;
  state: Partial<LocalJob>;
  author_group: string | null;
  author_id: string | null;
  author_name: string | null;
  author_type: string | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  error: string | null;
  retry_of_job_id: string | null;
};

export type ArtifactInput = {
  kind: "blog_zip" | "photo_zip" | "photo";
  article_id?: string;
  name?: string;
  object_key: string;
  mime_type: string;
  byte_size: number;
};
export type ArtifactRow = ArtifactInput & { id: string; job_id: string; expires_at: string };
export type CatalogQueryRequest =
  | { kind: "authors"; group: string }
  | { kind: "articles"; group: string; authorId: string; page: number }
  | { kind: "selection"; selection: SelectionRequest };
export type CatalogQueryRow = {
  id: string;
  owner_session_id: string;
  request: CatalogQueryRequest;
  status: "queued" | "running" | "succeeded" | "failed";
  result: Record<string, unknown> | null;
  error: string | null;
  lease_owner: string | null;
  lease_generation: number;
  created_at: string;
};

let client: SupabaseClient | undefined;
function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("Supabase のサーバー設定がありません。");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

function one<T>(data: T | T[] | null): T | null {
  return Array.isArray(data) ? data[0] ?? null : data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidClaimResponseError extends Error {
  readonly code = "INVALID_CLAIM_RESPONSE";
  constructor(rpc: string, reason: string) {
    super(`${rpc} の応答が不正です: ${reason}`);
    this.name = "InvalidClaimResponseError";
  }
}

function claimedRecord(data: unknown, rpc: string, workerId: string): Record<string, unknown> | null {
  if (data === null) return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    if (data.length !== 1) throw new InvalidClaimResponseError(rpc, "複数行");
    return claimedRecord(data[0], rpc, workerId);
  }
  if (typeof data !== "object" || data === null) throw new InvalidClaimResponseError(rpc, "オブジェクト以外");
  const row = data as Record<string, unknown>;
  // PostgREST may serialize a null composite return value as a row whose
  // columns are all null, instead of JSON null.
  if ("id" in row && row.id === null && Object.values(row).every((value) => value === null)) return null;
  if (typeof row.id !== "string" || !UUID.test(row.id)) throw new InvalidClaimResponseError(rpc, "ID");
  if (typeof row.owner_session_id !== "string" || !UUID.test(row.owner_session_id)) {
    throw new InvalidClaimResponseError(rpc, "所有セッションID");
  }
  if (row.status !== "running" || row.lease_owner !== workerId
    || !Number.isSafeInteger(row.lease_generation) || (row.lease_generation as number) < 1) {
    throw new InvalidClaimResponseError(rpc, "リース");
  }
  if (typeof row.request !== "object" || row.request === null || Array.isArray(row.request)) {
    throw new InvalidClaimResponseError(rpc, "取得条件");
  }
  return row;
}

export function parseClaimedJob(data: unknown, workerId: string): PublicJobRow | null {
  const row = claimedRecord(data, "claim_job", workerId);
  if (row === null) return null;
  if (row.kind !== "blog" && row.kind !== "photos") throw new InvalidClaimResponseError("claim_job", "保存種別");
  const request = row.request as Record<string, unknown>;
  if (!(typeof request.selection === "object" && request.selection !== null && !Array.isArray(request.selection))
    && !(Array.isArray(request.retryArticles) && typeof request.author === "object" && request.author !== null)) {
    throw new InvalidClaimResponseError("claim_job", "取得条件の内容");
  }
  if (typeof row.created_at !== "string" || typeof row.updated_at !== "string") {
    throw new InvalidClaimResponseError("claim_job", "日時");
  }
  return row as PublicJobRow;
}

export function parseClaimedCatalogQuery(data: unknown, workerId: string): CatalogQueryRow | null {
  const row = claimedRecord(data, "claim_catalog_query", workerId);
  if (row !== null && !["authors", "articles", "selection"].includes((row.request as Record<string, unknown>).kind as string)) {
    throw new InvalidClaimResponseError("claim_catalog_query", "一覧取得種別");
  }
  return row === null ? null : row as CatalogQueryRow;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createAccessSession(): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const { data, error } = await db().from("access_sessions")
    .insert({ token_hash: tokenHash(token), expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() })
    .select("id").single();
  if (error || !data) throw error ?? new Error("セッションを作成できませんでした。");
  return { id: data.id as string, token };
}

export async function findAccessSession(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { data, error } = await db().from("access_sessions").select("id")
    .eq("token_hash", tokenHash(token)).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export async function enqueuePublicJob(ownerId: string, kind: "blog" | "photos", request: PublicRequest, retryOf?: string): Promise<PublicJobRow> {
  const { data, error } = await db().rpc("enqueue_job", {
    p_session_id: ownerId, p_kind: kind, p_request: request, p_retry_of: retryOf ?? null,
  });
  if (error) throw error;
  const job = one(data) as PublicJobRow | null;
  if (!job) throw new Error("ジョブを作成できませんでした。");
  return job;
}

export async function getPublicJob(id: string): Promise<PublicJobRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data, error } = await db().from("jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data as PublicJobRow | null;
}

export async function getOwnedPublicJob(id: string, ownerId: string): Promise<PublicJobRow | null> {
  const job = await getPublicJob(id);
  return job?.owner_session_id === ownerId ? job : null;
}

export async function getArtifact(jobId: string, kind: ArtifactInput["kind"], articleId?: string, name?: string): Promise<ArtifactRow | null> {
  let query = db().from("artifacts").select("*").eq("job_id", jobId).eq("kind", kind)
    .gt("expires_at", new Date().toISOString());
  if (articleId) query = query.eq("article_id", articleId);
  if (name) query = query.eq("name", name);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as ArtifactRow | null;
}

export function publicJobView(row: PublicJobRow): LocalJob {
  const state = row.state ?? {};
  const author = row.author_group && row.author_id && row.author_name && row.author_type
    ? { group: row.author_group, id: row.author_id, name: row.author_name, type: row.author_type, listUrl: "" } as BlogAuthor
    : undefined;
  return {
    ...state,
    id: row.id,
    articleUrl: state.articleUrl ?? "",
    kind: row.kind,
    requestedAuthor: state.requestedAuthor ?? author,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    outputDirectory: "",
    log: state.log ?? [],
    error: row.error ?? state.error,
    retryOfJobId: row.retry_of_job_id ?? undefined,
  };
}

export async function claimPublicJob(workerId: string): Promise<PublicJobRow | null> {
  const { data, error } = await db().rpc("claim_job", { p_worker_id: workerId });
  if (error) throw error;
  return parseClaimedJob(data, workerId);
}

export async function heartbeatPublicJob(jobId: string, workerId: string, generation: number): Promise<boolean> {
  const { data, error } = await db().rpc("heartbeat_job", { p_job_id: jobId, p_worker_id: workerId, p_generation: generation });
  if (error) throw error;
  return data === true;
}

export async function progressPublicJob(jobId: string, workerId: string, generation: number,
  state: Partial<LocalJob>, author?: BlogAuthor): Promise<boolean> {
  const { data, error } = await db().rpc("progress_job", {
    p_job_id: jobId, p_worker_id: workerId, p_generation: generation,
    p_state: state, p_author: author ?? null,
  });
  if (error) throw error;
  return data === true;
}

export async function completePublicJob(jobId: string, workerId: string, generation: number,
  status: "succeeded" | "partial" | "failed", state: Partial<LocalJob>, errorText: string | null,
  artifacts: ArtifactInput[]): Promise<boolean> {
  const { data, error } = await db().rpc("complete_job", {
    p_job_id: jobId, p_worker_id: workerId, p_generation: generation,
    p_status: status, p_state: state, p_error: errorText, p_artifacts: artifacts,
  });
  if (error) throw error;
  return data === true;
}

export async function recoverStaleJobs(): Promise<void> {
  const { error } = await db().rpc("recover_stale_jobs");
  if (error) throw error;
}

export async function cleanupPublicData(): Promise<void> {
  const { error } = await db().rpc("cleanup_expired_public_data");
  if (error) throw error;
}

export async function workerLastSeen(): Promise<string | null> {
  const { data, error } = await db().from("worker_heartbeats").select("last_seen_at")
    .order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data?.last_seen_at ?? null;
}

export async function enqueueCatalogQuery(ownerId: string, request: CatalogQueryRequest): Promise<CatalogQueryRow> {
  const { data, error } = await db().rpc("enqueue_catalog_query", { p_session_id: ownerId, p_request: request });
  if (error) throw error;
  const row = one(data) as CatalogQueryRow | null;
  if (!row) throw new Error("一覧取得を開始できませんでした。");
  return row;
}

export async function getCatalogQuery(id: string, ownerId: string): Promise<CatalogQueryRow | null> {
  const { data, error } = await db().from("catalog_queries").select("*").eq("id", id)
    .eq("owner_session_id", ownerId).maybeSingle();
  if (error) throw error;
  return data as CatalogQueryRow | null;
}

export async function claimCatalogQuery(workerId: string): Promise<CatalogQueryRow | null> {
  const { data, error } = await db().rpc("claim_catalog_query", { p_worker_id: workerId });
  if (error) throw error;
  return parseClaimedCatalogQuery(data, workerId);
}

export async function heartbeatCatalogQuery(id: string, workerId: string, generation: number): Promise<boolean> {
  const { data, error } = await db().rpc("heartbeat_catalog_query", {
    p_query_id: id, p_worker_id: workerId, p_generation: generation,
  });
  if (error) throw error;
  return data === true;
}

export async function completeCatalogQuery(id: string, workerId: string, generation: number,
  result: Record<string, unknown> | null, errorText: string | null): Promise<boolean> {
  const { data, error } = await db().rpc("complete_catalog_query", {
    p_query_id: id, p_worker_id: workerId, p_generation: generation, p_result: result, p_error: errorText,
  });
  if (error) throw error;
  return data === true;
}
