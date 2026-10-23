-- The API and worker use service_role for direct reads. Mutations other than
-- access-session creation go through the existing SECURITY DEFINER functions.
grant usage on schema public to service_role;

revoke all on public.access_sessions, public.jobs, public.artifacts,
  public.worker_heartbeats, public.catalog_queries from service_role;

grant select, insert on public.access_sessions to service_role;
grant select on public.jobs, public.artifacts, public.worker_heartbeats,
  public.catalog_queries to service_role;
