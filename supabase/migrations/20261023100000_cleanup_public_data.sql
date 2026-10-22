-- The worker calls this periodically. R2 removes expired objects separately;
-- this removes their DB records and old owner data after access has ended.
create function public.cleanup_expired_public_data()
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_deleted integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(91009);
  perform pg_catalog.pg_advisory_xact_lock(91010);

  perform public.recover_stale_jobs();
  update public.jobs as job set status = 'failed',
    error = 'アクセス期間が終了したため、開始前のジョブを取り消しました。',
    finished_at = now(), updated_at = now()
  from public.access_sessions as session
  where job.owner_session_id = session.id and job.status = 'queued'
    and session.expires_at <= now();

  delete from public.artifacts where expires_at <= now();

  -- Retry jobs reference their predecessors. Delete old leaves first so the
  -- entire chain disappears once every result in it has passed retention.
  loop
    delete from public.jobs as job
    where job.status in ('succeeded', 'partial', 'failed')
      and job.finished_at < now() - interval '48 hours'
      and not exists (select 1 from public.jobs as child where child.retry_of_job_id = job.id);
    get diagnostics v_deleted = row_count;
    exit when v_deleted = 0;
  end loop;

  update public.catalog_queries set status = 'failed',
    error = '一覧取得が中断されました。もう一度お試しください。',
    lease_owner = null, lease_expires_at = null, updated_at = now()
  where status = 'running' and lease_expires_at < now();
  delete from public.catalog_queries as query
  where (query.status in ('succeeded', 'failed') and query.updated_at < now() - interval '24 hours')
    or (query.status <> 'running' and exists (
      select 1 from public.access_sessions as session
      where session.id = query.owner_session_id and session.expires_at <= now()
    ));

  delete from public.access_sessions as session
  where session.expires_at <= now()
    and not exists (select 1 from public.jobs as job where job.owner_session_id = session.id)
    and not exists (select 1 from public.catalog_queries as query where query.owner_session_id = session.id);
  delete from public.worker_heartbeats where last_seen_at < now() - interval '48 hours';
end;
$$;

create index jobs_retry_of_job_idx on public.jobs(retry_of_job_id) where retry_of_job_id is not null;
revoke execute on function public.cleanup_expired_public_data() from public, anon, authenticated;
grant execute on function public.cleanup_expired_public_data() to service_role;
