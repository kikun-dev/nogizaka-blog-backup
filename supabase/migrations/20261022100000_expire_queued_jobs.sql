-- Do not spend worker time on jobs whose owner can no longer access results.
-- Keep this as an additive migration so projects that already applied Issue #9
-- receive the same behavior as new installations.
create or replace function public.claim_job(p_worker_id uuid)
returns public.jobs
language plpgsql security definer set search_path = ''
as $$
declare v_job public.jobs;
begin
  perform pg_catalog.pg_advisory_xact_lock(91009);
  perform public.recover_stale_jobs();

  update public.jobs as job set status = 'failed',
    error = 'アクセス期間が終了したため、開始前のジョブを取り消しました。',
    finished_at = now(), updated_at = now()
  from public.access_sessions as session
  where job.owner_session_id = session.id and job.status = 'queued'
    and session.expires_at <= now();

  insert into public.worker_heartbeats(worker_id, last_seen_at) values (p_worker_id, now())
  on conflict (worker_id) do update set last_seen_at = excluded.last_seen_at;
  if exists (select 1 from public.jobs where status = 'running') then return null; end if;
  select job.* into v_job from public.jobs as job
    join public.access_sessions as session on session.id = job.owner_session_id
  where job.status = 'queued' and session.expires_at > now()
    order by job.created_at, job.id for update of job skip locked limit 1;
  if v_job.id is null then return null; end if;
  update public.jobs set status = 'running', lease_owner = p_worker_id,
    lease_generation = lease_generation + 1, lease_expires_at = now() + interval '90 seconds',
    started_at = now(), updated_at = now()
  where id = v_job.id returning * into v_job;
  return v_job;
end;
$$;
