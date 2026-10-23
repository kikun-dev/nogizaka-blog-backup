-- Issue #26: replace the single shared secret with independently revocable codes.
create table public.access_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  constraint access_codes_expiry_after_creation check (expires_at is null or expires_at > created_at)
);

alter table public.access_sessions add column access_code_id uuid references public.access_codes(id);
create index access_sessions_access_code_idx on public.access_sessions(access_code_id);
create index access_codes_active_idx on public.access_codes(expires_at) where revoked_at is null;

-- Existing sessions remain referenced by jobs and retry chains. Expire them in
-- place rather than deleting rows; NULL access_code_id also makes them ineligible.
update public.access_sessions set expires_at = least(expires_at, now());
update public.jobs set status='failed',error='アクセスコード移行のため、ジョブを中止しました。',lease_owner=null,
  lease_generation=lease_generation+1,lease_expires_at=null,finished_at=now(),updated_at=now()
  where status in ('queued','running');
update public.catalog_queries set status='failed',error='アクセスコード移行のため、一覧取得を中止しました。',lease_owner=null,
  lease_generation=lease_generation+1,lease_expires_at=null,updated_at=now()
  where status in ('queued','running');

create function public.cap_access_session_expiry()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_code_expiry timestamptz; v_revoked_at timestamptz;
begin
  if new.access_code_id is null then
    new.expires_at := least(new.expires_at, now());
    return new;
  end if;
  select expires_at, revoked_at into v_code_expiry, v_revoked_at from public.access_codes where id=new.access_code_id;
  if not found or v_revoked_at is not null or (v_code_expiry is not null and v_code_expiry<=now()) then
    new.expires_at := least(new.expires_at, now());
  elsif v_code_expiry is not null then
    new.expires_at := least(new.expires_at, v_code_expiry);
  end if;
  return new;
end;
$$;
create trigger cap_access_session_expiry before insert or update of expires_at, access_code_id
  on public.access_sessions for each row execute function public.cap_access_session_expiry();
revoke execute on function public.cap_access_session_expiry() from public, anon, authenticated, service_role;

create table public.access_login_attempts (
  rate_key text primary key,
  window_started_at timestamptz not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  blocked_until timestamptz
);
alter table public.access_codes enable row level security;
alter table public.access_login_attempts enable row level security;
revoke all on public.access_codes, public.access_login_attempts from anon, authenticated, service_role;

create function public.session_has_active_code(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.access_sessions s join public.access_codes c on c.id = s.access_code_id
    where s.id = p_session_id and s.expires_at > now() and c.revoked_at is null
      and (c.expires_at is null or c.expires_at > now())
  );
$$;

create function public.authenticate_access_code(p_code_hash text, p_token_hash text, p_rate_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_attempt public.access_login_attempts; v_code public.access_codes; v_session_id uuid;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_rate_key !~ '^[0-9a-f]{64}$' then return null; end if;
  insert into public.access_login_attempts(rate_key, window_started_at)
    values (p_rate_key, now()) on conflict (rate_key) do nothing;
  select * into v_attempt from public.access_login_attempts where rate_key = p_rate_key for update;
  if v_attempt.blocked_until > now() then return null; end if;
  if v_attempt.window_started_at <= now() - interval '15 minutes' then
    update public.access_login_attempts set window_started_at = now(), failed_attempts = 0,
      blocked_until = null where rate_key = p_rate_key returning * into v_attempt;
  end if;
  select * into v_code from public.access_codes where code_hash = p_code_hash
    and revoked_at is null and (expires_at is null or expires_at > now()) for update;
  if v_code.id is null then
    update public.access_login_attempts set failed_attempts = failed_attempts + 1,
      blocked_until = case when failed_attempts + 1 >= 10 then now() + interval '15 minutes' else null end
      where rate_key = p_rate_key;
    return null;
  end if;
  update public.access_login_attempts set failed_attempts = 0, blocked_until = null, window_started_at = now()
    where rate_key = p_rate_key;
  insert into public.access_sessions(token_hash, access_code_id, expires_at)
    values (p_token_hash, v_code.id, least(now() + interval '24 hours', coalesce(v_code.expires_at, 'infinity'::timestamptz)))
    returning id into v_session_id;
  update public.access_codes set last_used_at = now() where id = v_code.id;
  return v_session_id;
end;
$$;

create function public.find_access_session(p_token_hash text)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id from public.access_sessions s join public.access_codes c on c.id = s.access_code_id
  where s.token_hash = p_token_hash and s.expires_at > now() and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now()) limit 1;
$$;

create function public.admin_create_access_code(p_code_hash text, p_display_name text, p_expires_at timestamptz)
returns table(id uuid, display_name text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' or length(btrim(p_display_name)) not between 1 and 120
    or (p_expires_at is not null and p_expires_at <= now()) then raise exception 'invalid_access_code'; end if;
  return query insert into public.access_codes(code_hash, display_name, expires_at)
    values (p_code_hash, btrim(p_display_name), p_expires_at)
    returning access_codes.id, access_codes.display_name, access_codes.created_at, access_codes.expires_at;
end;
$$;

create function public.admin_list_access_codes()
returns table(id uuid, display_name text, created_at timestamptz, expires_at timestamptz,
  revoked_at timestamptz, last_used_at timestamptz, status text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.display_name, c.created_at, c.expires_at, c.revoked_at, c.last_used_at,
    case when c.revoked_at is not null then 'revoked'
      when c.expires_at is not null and c.expires_at <= now() then 'expired' else 'active' end
  from public.access_codes c order by c.created_at desc;
$$;

create function public.admin_revoke_access_code(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := now();
begin
  update public.access_codes set revoked_at = v_now where id = p_id and revoked_at is null;
  if not found then return false; end if;
  update public.access_sessions set expires_at = least(expires_at, v_now) where access_code_id = p_id;
  update public.jobs set status = 'failed', error = 'アクセスコードが無効になったため、ジョブを中止しました。',
    lease_owner = null, lease_generation = lease_generation + 1, lease_expires_at = null,
    finished_at = v_now, updated_at = v_now
    where owner_session_id in (select id from public.access_sessions where access_code_id = p_id)
      and status in ('queued', 'running');
  update public.catalog_queries set status = 'failed', error = 'アクセスコードが無効になったため、一覧取得を中止しました。',
    lease_owner = null, lease_generation = lease_generation + 1, lease_expires_at = null, updated_at = v_now
    where owner_session_id in (select id from public.access_sessions where access_code_id = p_id)
      and status in ('queued', 'running');
  return true;
end;
$$;

create or replace function public.enqueue_job(p_session_id uuid, p_kind text, p_request jsonb, p_retry_of uuid default null)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  perform pg_catalog.pg_advisory_xact_lock(91009);
  if not public.session_has_active_code(p_session_id) then raise exception 'session_expired'; end if;
  if p_kind not in ('blog', 'photos') or pg_catalog.jsonb_typeof(p_request) <> 'object' then raise exception 'invalid_request'; end if;
  if p_retry_of is not null and not exists (select 1 from public.jobs where id = p_retry_of and owner_session_id = p_session_id) then raise exception 'retry_not_found'; end if;
  if (select count(*) from public.jobs where status in ('queued', 'running') and owner_session_id = p_session_id) >= 1 then raise exception 'session_capacity'; end if;
  if (select count(*) from public.jobs where status in ('queued', 'running')) >= 11 then raise exception 'global_capacity'; end if;
  if exists (select 1 from public.jobs where owner_session_id = p_session_id and created_at > now() - interval '10 seconds') then raise exception 'submit_cooldown'; end if;
  insert into public.jobs(owner_session_id, kind, request, retry_of_job_id) values (p_session_id, p_kind, p_request, p_retry_of) returning * into v_job;
  return v_job;
end;
$$;

create or replace function public.enqueue_catalog_query(p_session_id uuid, p_request jsonb)
returns public.catalog_queries language plpgsql security definer set search_path = '' as $$
declare v_query public.catalog_queries;
begin
  perform pg_catalog.pg_advisory_xact_lock(91010);
  if not public.session_has_active_code(p_session_id) then raise exception 'session_expired'; end if;
  if pg_catalog.jsonb_typeof(p_request) <> 'object' then raise exception 'invalid_request'; end if;
  if (select count(*) from public.catalog_queries where owner_session_id = p_session_id and status in ('queued', 'running')) >= 3 then raise exception 'catalog_session_capacity'; end if;
  if (select count(*) from public.catalog_queries where status in ('queued', 'running')) >= 20 then raise exception 'catalog_global_capacity'; end if;
  insert into public.catalog_queries(owner_session_id, request) values (p_session_id, p_request) returning * into v_query;
  return v_query;
end;
$$;

create or replace function public.claim_catalog_query(p_worker_id uuid)
returns public.catalog_queries language plpgsql security definer set search_path = '' as $$
declare v_query public.catalog_queries;
begin
  perform pg_catalog.pg_advisory_xact_lock(91010);
  delete from public.catalog_queries where status in ('succeeded','failed') and updated_at<now()-interval '1 day';
  update public.catalog_queries q set status='failed',error='アクセス期間が終了したため、一覧取得を中止しました。',updated_at=now()
    where q.status='queued' and not public.session_has_active_code(q.owner_session_id);
  update public.catalog_queries set status='failed',error='一覧取得を待つ時間が長すぎました。もう一度お試しください。',updated_at=now()
    where status='queued' and created_at<now()-interval '2 minutes';
  update public.catalog_queries set status='failed',error='一覧取得が中断されました。もう一度お試しください。',lease_owner=null,lease_expires_at=null,updated_at=now()
    where status='running' and lease_expires_at<now();
  insert into public.worker_heartbeats(worker_id,last_seen_at) values (p_worker_id,now())
    on conflict (worker_id) do update set last_seen_at=excluded.last_seen_at;
  if exists(select 1 from public.catalog_queries where status='running') then return null; end if;
  select q.* into v_query from public.catalog_queries q where q.status='queued'
    and public.session_has_active_code(q.owner_session_id) order by q.created_at,q.id for update skip locked limit 1;
  if v_query.id is null then return null; end if;
  update public.catalog_queries set status='running',lease_owner=p_worker_id,lease_generation=lease_generation+1,
    lease_expires_at=now()+interval '90 seconds',updated_at=now() where id=v_query.id returning * into v_query;
  return v_query;
end;
$$;

create or replace function public.heartbeat_catalog_query(p_query_id uuid,p_worker_id uuid,p_generation integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.session_has_active_code((select owner_session_id from public.catalog_queries where id=p_query_id)) then return false; end if;
  update public.catalog_queries set lease_expires_at=now()+interval '90 seconds',updated_at=now()
    where id=p_query_id and status='running' and lease_owner=p_worker_id and lease_generation=p_generation and lease_expires_at>now();
  if not found then return false; end if;
  update public.worker_heartbeats set last_seen_at=now() where worker_id=p_worker_id;
  return true;
end;
$$;

create or replace function public.complete_catalog_query(p_query_id uuid,p_worker_id uuid,p_generation integer,p_result jsonb,p_error text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.session_has_active_code((select owner_session_id from public.catalog_queries where id=p_query_id)) then return false; end if;
  update public.catalog_queries set status=case when p_error is null then 'succeeded' else 'failed' end,
    result=p_result,error=p_error,lease_owner=null,lease_expires_at=null,updated_at=now()
    where id=p_query_id and status='running' and lease_owner=p_worker_id and lease_generation=p_generation and lease_expires_at>now();
  return found;
end;
$$;

create or replace function public.claim_job(p_worker_id uuid)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  perform pg_catalog.pg_advisory_xact_lock(91009);
  perform public.recover_stale_jobs();
  update public.jobs j set status='failed', error='アクセス期間が終了したため、開始前のジョブを取り消しました。',
    finished_at=now(), updated_at=now()
    where j.status='queued' and not public.session_has_active_code(j.owner_session_id);
  insert into public.worker_heartbeats(worker_id,last_seen_at) values (p_worker_id,now())
    on conflict (worker_id) do update set last_seen_at=excluded.last_seen_at;
  if exists (select 1 from public.jobs where status='running') then return null; end if;
  select j.* into v_job from public.jobs j where j.status='queued'
    and public.session_has_active_code(j.owner_session_id) order by j.created_at,j.id for update skip locked limit 1;
  if v_job.id is null then return null; end if;
  update public.jobs set status='running',lease_owner=p_worker_id,lease_generation=lease_generation+1,
    lease_expires_at=now()+interval '90 seconds',started_at=now(),updated_at=now()
    where id=v_job.id returning * into v_job;
  update public.access_sessions s set expires_at=least(greatest(s.expires_at,now()+interval '24 hours'),c.expires_at)
    from public.access_codes c where s.id=v_job.owner_session_id and c.id=s.access_code_id
      and c.revoked_at is null and (c.expires_at is null or c.expires_at>now());
  return v_job;
end;
$$;

create or replace function public.heartbeat_job(p_job_id uuid,p_worker_id uuid,p_generation integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  select owner_session_id into v_owner from public.jobs where id=p_job_id;
  if not public.session_has_active_code(v_owner) then return false; end if;
  update public.jobs set lease_expires_at=now()+interval '90 seconds',updated_at=now()
    where id=p_job_id and status='running' and lease_owner=p_worker_id and lease_generation=p_generation and lease_expires_at>now();
  if not found then return false; end if;
  update public.worker_heartbeats set last_seen_at=now() where worker_id=p_worker_id;
  update public.access_sessions s set expires_at=least(greatest(s.expires_at,now()+interval '24 hours'),c.expires_at)
    from public.jobs j join public.access_codes c on c.id=(select access_code_id from public.access_sessions where id=j.owner_session_id)
    where j.id=p_job_id and s.id=j.owner_session_id and c.revoked_at is null and (c.expires_at is null or c.expires_at>now());
  return true;
end;
$$;

create or replace function public.progress_job(p_job_id uuid,p_worker_id uuid,p_generation integer,p_state jsonb,p_author jsonb default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if pg_catalog.jsonb_typeof(p_state)<>'object' or not public.session_has_active_code((select owner_session_id from public.jobs where id=p_job_id)) then return false; end if;
  update public.jobs set state=p_state,author_group=coalesce(p_author->>'group',author_group),
    author_id=coalesce(p_author->>'id',author_id),author_name=coalesce(p_author->>'name',author_name),
    author_type=coalesce(p_author->>'type',author_type),updated_at=now()
    where id=p_job_id and status='running' and lease_owner=p_worker_id and lease_generation=p_generation and lease_expires_at>now();
  return found;
end;
$$;

create or replace function public.complete_job(p_job_id uuid,p_worker_id uuid,p_generation integer,p_status text,p_state jsonb,p_error text,p_artifacts jsonb default '[]'::jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_artifact jsonb;
begin
  if p_status not in ('succeeded','partial','failed') or pg_catalog.jsonb_typeof(p_state)<>'object'
    or pg_catalog.jsonb_typeof(p_artifacts)<>'array' then return false; end if;
  select * into v_job from public.jobs where id=p_job_id for update;
  if v_job.id is null or v_job.status<>'running' or v_job.lease_owner<>p_worker_id or v_job.lease_generation<>p_generation
    or v_job.lease_expires_at<=now() or not public.session_has_active_code(v_job.owner_session_id) then return false; end if;
  for v_artifact in select value from pg_catalog.jsonb_array_elements(p_artifacts) loop
    if not (v_artifact->>'object_key' like p_job_id::text||'/'||p_generation::text||'/%') or (v_artifact->>'byte_size')::bigint<0 then raise exception 'invalid_artifact'; end if;
    insert into public.artifacts(job_id,lease_generation,kind,article_id,name,object_key,mime_type,byte_size,expires_at)
      values (p_job_id,p_generation,v_artifact->>'kind',v_artifact->>'article_id',v_artifact->>'name',v_artifact->>'object_key',v_artifact->>'mime_type',(v_artifact->>'byte_size')::bigint,now()+interval '24 hours');
  end loop;
  update public.jobs set status=p_status,state=p_state,error=p_error,lease_owner=null,lease_expires_at=null,finished_at=now(),updated_at=now() where id=p_job_id;
  update public.access_sessions s set expires_at=least(greatest(s.expires_at,now()+interval '24 hours'),c.expires_at)
    from public.access_codes c where s.id=v_job.owner_session_id and c.id=s.access_code_id and c.revoked_at is null and (c.expires_at is null or c.expires_at>now());
  return true;
end;
$$;

create or replace function public.cleanup_expired_public_data()
returns void language plpgsql security definer set search_path = '' as $$
declare v_deleted integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(91009); perform pg_catalog.pg_advisory_xact_lock(91010);
  perform public.recover_stale_jobs();
  update public.jobs j set status='failed',error='アクセス期間が終了したため、ジョブを中止しました。',lease_owner=null,
    lease_generation=lease_generation+1,lease_expires_at=null,finished_at=now(),updated_at=now()
    where j.status in ('queued','running') and not public.session_has_active_code(j.owner_session_id);
  update public.catalog_queries q set status='failed',error='アクセス期間が終了したため、一覧取得を中止しました。',
    lease_owner=null,lease_generation=lease_generation+1,lease_expires_at=null,updated_at=now()
    where q.status in ('queued','running') and not public.session_has_active_code(q.owner_session_id);
  delete from public.artifacts where expires_at<=now();
  loop
    delete from public.jobs j where j.status in ('succeeded','partial','failed') and j.finished_at<now()-interval '48 hours'
      and not exists(select 1 from public.jobs child where child.retry_of_job_id=j.id);
    get diagnostics v_deleted=row_count; exit when v_deleted=0;
  end loop;
  update public.catalog_queries set status='failed',error='一覧取得が中断されました。もう一度お試しください。',lease_owner=null,lease_expires_at=null,updated_at=now()
    where status='running' and lease_expires_at<now();
  delete from public.catalog_queries q where q.status in ('succeeded','failed') and q.updated_at<now()-interval '24 hours';
  delete from public.access_sessions s where s.expires_at<=now() and not exists(select 1 from public.jobs j where j.owner_session_id=s.id)
    and not exists(select 1 from public.catalog_queries q where q.owner_session_id=s.id);
  delete from public.access_codes c where (c.revoked_at is not null or (c.expires_at is not null and c.expires_at<=now()))
    and not exists(select 1 from public.access_sessions s where s.access_code_id=c.id);
  delete from public.access_login_attempts where window_started_at<now()-interval '1 day';
  delete from public.worker_heartbeats where last_seen_at<now()-interval '48 hours';
end;
$$;

revoke execute on function public.session_has_active_code(uuid), public.authenticate_access_code(text,text,text), public.find_access_session(text),
  public.admin_create_access_code(text,text,timestamptz), public.admin_list_access_codes(), public.admin_revoke_access_code(uuid) from public, anon, authenticated;
grant execute on function public.session_has_active_code(uuid), public.authenticate_access_code(text,text,text), public.find_access_session(text),
  public.admin_create_access_code(text,text,timestamptz), public.admin_list_access_codes(), public.admin_revoke_access_code(uuid) to service_role;
revoke execute on function public.cleanup_expired_public_data() from public, anon, authenticated;
grant execute on function public.cleanup_expired_public_data() to service_role;
