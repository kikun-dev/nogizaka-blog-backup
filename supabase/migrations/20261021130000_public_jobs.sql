-- Issue #9: the Data API is accessed only by trusted server processes.
create table public.access_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_session_id uuid not null references public.access_sessions(id),
  kind text not null check (kind in ('blog', 'photos')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'partial', 'failed')),
  request jsonb not null,
  state jsonb not null default '{}'::jsonb,
  author_group text check (author_group in ('nogizaka', 'sakurazaka', 'hinatazaka')),
  author_id text,
  author_name text,
  author_type text check (author_type in ('member', 'generation', 'staff', 'mascot', 'other')),
  lease_owner uuid,
  lease_generation integer not null default 0,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  retry_of_job_id uuid references public.jobs(id),
  constraint request_object check (jsonb_typeof(request) = 'object'),
  constraint state_object check (jsonb_typeof(state) = 'object')
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  lease_generation integer not null,
  kind text not null check (kind in ('blog_zip', 'photo_zip', 'photo')),
  article_id text,
  name text,
  object_key text not null unique,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (job_id, kind, article_id, name)
);

create table public.worker_heartbeats (
  worker_id uuid primary key,
  last_seen_at timestamptz not null default now()
);

create table public.catalog_queries (
  id uuid primary key default gen_random_uuid(),
  owner_session_id uuid not null references public.access_sessions(id),
  request jsonb not null check (jsonb_typeof(request) = 'object'),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  result jsonb,
  error text,
  lease_owner uuid,
  lease_generation integer not null default 0,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_owner_created_idx on public.jobs(owner_session_id, created_at desc);
create index jobs_queue_idx on public.jobs(created_at) where status = 'queued';
create index jobs_lease_idx on public.jobs(lease_expires_at) where status = 'running';
create index artifacts_job_expiry_idx on public.artifacts(job_id, expires_at);
create index sessions_expiry_idx on public.access_sessions(expires_at);
create index catalog_queries_queue_idx on public.catalog_queries(created_at) where status = 'queued';
create index catalog_queries_owner_idx on public.catalog_queries(owner_session_id, created_at desc);

alter table public.access_sessions enable row level security;
alter table public.jobs enable row level security;
alter table public.artifacts enable row level security;
alter table public.worker_heartbeats enable row level security;
alter table public.catalog_queries enable row level security;
revoke all on public.access_sessions, public.jobs, public.artifacts, public.worker_heartbeats, public.catalog_queries from anon, authenticated;

create function public.enqueue_catalog_query(p_session_id uuid, p_request jsonb)
returns public.catalog_queries
language plpgsql security definer set search_path = ''
as $$
declare v_query public.catalog_queries;
begin
  perform pg_catalog.pg_advisory_xact_lock(91010);
  if not exists (select 1 from public.access_sessions where id = p_session_id and expires_at > now()) then
    raise exception 'session_expired';
  end if;
  if pg_catalog.jsonb_typeof(p_request) <> 'object' then raise exception 'invalid_request'; end if;
  if (select count(*) from public.catalog_queries where owner_session_id = p_session_id
    and status in ('queued', 'running')) >= 3 then raise exception 'catalog_session_capacity'; end if;
  if (select count(*) from public.catalog_queries where status in ('queued', 'running')) >= 20 then
    raise exception 'catalog_global_capacity'; end if;
  insert into public.catalog_queries(owner_session_id, request) values (p_session_id, p_request)
    returning * into v_query;
  return v_query;
end;
$$;

create function public.claim_catalog_query(p_worker_id uuid)
returns public.catalog_queries
language plpgsql security definer set search_path = ''
as $$
declare v_query public.catalog_queries;
begin
  perform pg_catalog.pg_advisory_xact_lock(91010);
  delete from public.catalog_queries where status in ('succeeded', 'failed')
    and updated_at < now() - interval '1 day';
  update public.catalog_queries set status = 'failed', error = '一覧取得を待つ時間が長すぎました。もう一度お試しください。',
    updated_at = now() where status = 'queued' and created_at < now() - interval '2 minutes';
  update public.catalog_queries set status = 'failed', error = '一覧取得が中断されました。もう一度お試しください。',
    lease_owner = null, lease_expires_at = null, updated_at = now()
    where status = 'running' and lease_expires_at < now();
  insert into public.worker_heartbeats(worker_id,last_seen_at) values (p_worker_id,now())
    on conflict (worker_id) do update set last_seen_at = excluded.last_seen_at;
  if exists (select 1 from public.catalog_queries where status = 'running') then return null; end if;
  select * into v_query from public.catalog_queries where status = 'queued'
    order by created_at, id for update skip locked limit 1;
  if v_query.id is null then return null; end if;
  update public.catalog_queries set status = 'running', lease_owner = p_worker_id,
    lease_generation = lease_generation + 1, lease_expires_at = now() + interval '90 seconds',
    updated_at = now() where id = v_query.id returning * into v_query;
  return v_query;
end;
$$;

create function public.heartbeat_catalog_query(p_query_id uuid, p_worker_id uuid, p_generation integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.worker_heartbeats set last_seen_at = now() where worker_id = p_worker_id;
  update public.catalog_queries set lease_expires_at = now() + interval '90 seconds', updated_at = now()
  where id = p_query_id and status = 'running' and lease_owner = p_worker_id
    and lease_generation = p_generation and lease_expires_at > now();
  return found;
end;
$$;

create function public.complete_catalog_query(p_query_id uuid, p_worker_id uuid, p_generation integer,
  p_result jsonb, p_error text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.catalog_queries set status = case when p_error is null then 'succeeded' else 'failed' end,
    result = p_result, error = p_error, lease_owner = null, lease_expires_at = null, updated_at = now()
  where id = p_query_id and status = 'running' and lease_owner = p_worker_id
    and lease_generation = p_generation and lease_expires_at > now();
  return found;
end;
$$;

-- A single transaction lock makes capacity and per-session limits reliable even
-- when multiple Vercel functions submit simultaneously.
create function public.enqueue_job(p_session_id uuid, p_kind text, p_request jsonb, p_retry_of uuid default null)
returns public.jobs
language plpgsql security definer set search_path = ''
as $$
declare v_job public.jobs;
begin
  perform pg_catalog.pg_advisory_xact_lock(91009);
  if not exists (select 1 from public.access_sessions where id = p_session_id and expires_at > now()) then
    raise exception 'session_expired';
  end if;
  if p_kind not in ('blog', 'photos') or pg_catalog.jsonb_typeof(p_request) <> 'object' then
    raise exception 'invalid_request';
  end if;
  if (select count(*) from public.jobs where status in ('queued', 'running') and owner_session_id = p_session_id) >= 1 then
    raise exception 'session_capacity';
  end if;
  if (select count(*) from public.jobs where status in ('queued', 'running')) >= 11 then
    raise exception 'global_capacity';
  end if;
  if exists (select 1 from public.jobs where owner_session_id = p_session_id and created_at > now() - interval '10 seconds') then
    raise exception 'submit_cooldown';
  end if;
  insert into public.jobs (owner_session_id, kind, request, retry_of_job_id)
  values (p_session_id, p_kind, p_request, p_retry_of) returning * into v_job;
  return v_job;
end;
$$;

create function public.recover_stale_jobs()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  update public.jobs set status = 'failed', error = 'ワーカーが中断しました。再試行してください。',
    lease_owner = null, lease_expires_at = null, finished_at = now(), updated_at = now()
  where status = 'running' and lease_expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.claim_job(p_worker_id uuid)
returns public.jobs
language plpgsql security definer set search_path = ''
as $$
declare v_job public.jobs;
begin
  perform pg_catalog.pg_advisory_xact_lock(91009);
  perform public.recover_stale_jobs();
  insert into public.worker_heartbeats(worker_id, last_seen_at) values (p_worker_id, now())
  on conflict (worker_id) do update set last_seen_at = excluded.last_seen_at;
  if exists (select 1 from public.jobs where status = 'running') then return null; end if;
  select * into v_job from public.jobs where status = 'queued'
    order by created_at, id for update skip locked limit 1;
  if v_job.id is null then return null; end if;
  update public.jobs set status = 'running', lease_owner = p_worker_id,
    lease_generation = lease_generation + 1, lease_expires_at = now() + interval '90 seconds',
    started_at = now(), updated_at = now()
  where id = v_job.id returning * into v_job;
  return v_job;
end;
$$;

create function public.heartbeat_job(p_job_id uuid, p_worker_id uuid, p_generation integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.worker_heartbeats set last_seen_at = now() where worker_id = p_worker_id;
  update public.jobs set lease_expires_at = now() + interval '90 seconds', updated_at = now()
  where id = p_job_id and status = 'running' and lease_owner = p_worker_id
    and lease_generation = p_generation and lease_expires_at > now();
  return found;
end;
$$;

create function public.progress_job(p_job_id uuid, p_worker_id uuid, p_generation integer,
  p_state jsonb, p_author jsonb default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(p_state) <> 'object' then return false; end if;
  update public.jobs set state = p_state,
    author_group = coalesce(p_author->>'group', author_group),
    author_id = coalesce(p_author->>'id', author_id),
    author_name = coalesce(p_author->>'name', author_name),
    author_type = coalesce(p_author->>'type', author_type), updated_at = now()
  where id = p_job_id and status = 'running' and lease_owner = p_worker_id
    and lease_generation = p_generation and lease_expires_at > now();
  return found;
end;
$$;

-- The lease check, artifact registration, and terminal state commit are one
-- transaction. An old worker can upload only to its generation-scoped R2 key;
-- it cannot publish that object to a newer job attempt.
create function public.complete_job(p_job_id uuid, p_worker_id uuid, p_generation integer,
  p_status text, p_state jsonb, p_error text, p_artifacts jsonb default '[]'::jsonb)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_job public.jobs; v_artifact jsonb;
begin
  if p_status not in ('succeeded', 'partial', 'failed')
    or pg_catalog.jsonb_typeof(p_state) <> 'object'
    or pg_catalog.jsonb_typeof(p_artifacts) <> 'array' then return false; end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner <> p_worker_id
    or v_job.lease_generation <> p_generation or v_job.lease_expires_at <= now() then return false; end if;
  for v_artifact in select value from pg_catalog.jsonb_array_elements(p_artifacts) loop
    if not (v_artifact->>'object_key' like p_job_id::text || '/' || p_generation::text || '/%')
      or (v_artifact->>'byte_size')::bigint < 0 then raise exception 'invalid_artifact'; end if;
    insert into public.artifacts(job_id, lease_generation, kind, article_id, name, object_key, mime_type, byte_size, expires_at)
    values (p_job_id, p_generation, v_artifact->>'kind', v_artifact->>'article_id',
      v_artifact->>'name', v_artifact->>'object_key', v_artifact->>'mime_type',
      (v_artifact->>'byte_size')::bigint, now() + interval '24 hours');
  end loop;
  update public.jobs set status = p_status, state = p_state, error = p_error,
    lease_owner = null, lease_expires_at = null, finished_at = now(), updated_at = now()
  where id = p_job_id;
  return true;
end;
$$;

revoke execute on function public.enqueue_job(uuid,text,jsonb,uuid) from public, anon, authenticated;
revoke execute on function public.recover_stale_jobs() from public, anon, authenticated;
revoke execute on function public.claim_job(uuid) from public, anon, authenticated;
revoke execute on function public.heartbeat_job(uuid,uuid,integer) from public, anon, authenticated;
revoke execute on function public.progress_job(uuid,uuid,integer,jsonb,jsonb) from public, anon, authenticated;
revoke execute on function public.complete_job(uuid,uuid,integer,text,jsonb,text,jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_job(uuid,text,jsonb,uuid) to service_role;
grant execute on function public.recover_stale_jobs() to service_role;
grant execute on function public.claim_job(uuid) to service_role;
grant execute on function public.heartbeat_job(uuid,uuid,integer) to service_role;
grant execute on function public.progress_job(uuid,uuid,integer,jsonb,jsonb) to service_role;
grant execute on function public.complete_job(uuid,uuid,integer,text,jsonb,text,jsonb) to service_role;
revoke execute on function public.enqueue_catalog_query(uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.claim_catalog_query(uuid) from public, anon, authenticated;
revoke execute on function public.heartbeat_catalog_query(uuid,uuid,integer) from public, anon, authenticated;
revoke execute on function public.complete_catalog_query(uuid,uuid,integer,jsonb,text) from public, anon, authenticated;
grant execute on function public.enqueue_catalog_query(uuid,jsonb) to service_role;
grant execute on function public.claim_catalog_query(uuid) to service_role;
grant execute on function public.heartbeat_catalog_query(uuid,uuid,integer) to service_role;
grant execute on function public.complete_catalog_query(uuid,uuid,integer,jsonb,text) to service_role;
