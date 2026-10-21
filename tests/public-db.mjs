import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

async function database() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../supabase/migrations/20261021130000_public_jobs.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261022120000_service_role_table_privileges.sql", import.meta.url), "utf8"));
  return db;
}

test("service_role receives only required direct table privileges while RLS and RPC restrictions remain", async () => {
  const db = await database();
  try {
    const tables = ["access_sessions", "jobs", "artifacts", "worker_heartbeats", "catalog_queries"];
    for (const table of tables) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const expected = privilege === "SELECT" || (table === "access_sessions" && privilege === "INSERT");
        const result = await db.query("select has_table_privilege('service_role',$1,$2) as allowed", [`public.${table}`, privilege]);
        assert.equal(result.rows[0].allowed, expected, `service_role ${privilege} on ${table}`);
        for (const role of ["anon", "authenticated"]) {
          const denied = await db.query("select has_table_privilege($1,$2,$3) as allowed", [role, `public.${table}`, privilege]);
          assert.equal(denied.rows[0].allowed, false, `${role} ${privilege} on ${table}`);
        }
      }
    }
    const schema = await db.query("select has_schema_privilege('service_role','public','USAGE') as allowed");
    assert.equal(schema.rows[0].allowed, true);
    const rls = await db.query(`select relname, relrowsecurity from pg_catalog.pg_class
      where relnamespace = 'public'::regnamespace and relname in
      ('access_sessions','jobs','artifacts','worker_heartbeats','catalog_queries')`);
    assert.equal(rls.rows.length, tables.length);
    assert.ok(rls.rows.every((row) => row.relrowsecurity === true));

    const functions = [
      "enqueue_job(uuid,text,jsonb,uuid)", "recover_stale_jobs()", "claim_job(uuid)",
      "heartbeat_job(uuid,uuid,integer)", "progress_job(uuid,uuid,integer,jsonb,jsonb)",
      "complete_job(uuid,uuid,integer,text,jsonb,text,jsonb)", "enqueue_catalog_query(uuid,jsonb)",
      "claim_catalog_query(uuid)", "heartbeat_catalog_query(uuid,uuid,integer)",
      "complete_catalog_query(uuid,uuid,integer,jsonb,text)",
    ];
    for (const signature of functions) {
      for (const role of ["service_role", "anon", "authenticated"]) {
        const result = await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, `public.${signature}`]);
        assert.equal(result.rows[0].allowed, role === "service_role", `${role} EXECUTE ${signature}`);
      }
    }

    await db.exec("set role service_role");
    try {
      const created = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('service-session',now()+interval '1 day') returning id");
      const read = await db.query("select id from public.access_sessions where id=$1", [created.rows[0].id]);
      assert.equal(read.rows[0].id, created.rows[0].id);
      const job = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [created.rows[0].id]);
      const claimed = await db.query("select (public.claim_job($1)).id as id", ["22222222-2222-4222-8222-222222222222"]);
      assert.equal(claimed.rows[0].id, job.rows[0].id);
      await assert.rejects(db.query("update public.access_sessions set expires_at=now() where id=$1", [created.rows[0].id]), /permission denied/);
      await assert.rejects(db.query("insert into public.worker_heartbeats(worker_id) values ('11111111-1111-4111-8111-111111111111')"), /permission denied/);
    } finally { await db.exec("reset role"); }
  } finally { await db.close(); }
});

test("worker skips queued jobs after the owner session expires", async () => {
  const db = await database();
  try {
    const expiredSession = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('expired',now()+interval '1 day') returning id");
    const expiredOwner = expiredSession.rows[0].id;
    const oldJob = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [expiredOwner]);
    await db.query("update public.access_sessions set expires_at=now()-interval '1 second' where id=$1", [expiredOwner]);

    const currentSession = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('current',now()+interval '1 day') returning id");
    const currentJob = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [currentSession.rows[0].id]);
    const worker = "44444444-4444-4444-8444-444444444444";
    const claimed = await db.query("select (public.claim_job($1)).id as id", [worker]);
    assert.equal(claimed.rows[0].id, currentJob.rows[0].id);

    const expired = await db.query("select status,lease_generation,finished_at from public.jobs where id=$1", [oldJob.rows[0].id]);
    assert.equal(expired.rows[0].status, "failed");
    assert.equal(expired.rows[0].lease_generation, 0);
    assert.ok(expired.rows[0].finished_at);
  } finally { await db.close(); }
});

test("the owner session remains valid through processing and artifact expiry", async () => {
  const db = await database();
  try {
    const session = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('near-expiry',now()+interval '1 minute') returning id");
    const owner = session.rows[0].id;
    const created = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [owner]);
    const jobId = created.rows[0].id;
    const worker = "55555555-5555-4555-8555-555555555555";
    const claimed = await db.query("select (public.claim_job($1)).lease_generation as generation", [worker]);
    assert.equal(claimed.rows[0].generation, 1);
    const afterClaim = await db.query("select expires_at > now()+interval '23 hours' as valid from public.access_sessions where id=$1", [owner]);
    assert.equal(afterClaim.rows[0].valid, true);

    await db.query("update public.access_sessions set expires_at=now()+interval '1 minute' where id=$1", [owner]);
    const staleHeartbeat = await db.query("select public.heartbeat_job($1,$2,0) as accepted", [jobId, worker]);
    assert.equal(staleHeartbeat.rows[0].accepted, false);
    const afterStaleHeartbeat = await db.query("select expires_at < now()+interval '2 minutes' as unchanged from public.access_sessions where id=$1", [owner]);
    assert.equal(afterStaleHeartbeat.rows[0].unchanged, true);
    const heartbeat = await db.query("select public.heartbeat_job($1,$2,1) as accepted", [jobId, worker]);
    assert.equal(heartbeat.rows[0].accepted, true);
    const afterHeartbeat = await db.query("select expires_at > now()+interval '23 hours' as valid from public.access_sessions where id=$1", [owner]);
    assert.equal(afterHeartbeat.rows[0].valid, true);

    await db.query("update public.access_sessions set expires_at=now()+interval '1 minute' where id=$1", [owner]);
    const artifact = JSON.stringify([{ kind: "blog_zip", object_key: `${jobId}/1/blogs.zip`, mime_type: "application/zip", byte_size: 123 }]);
    const completed = await db.query("select public.complete_job($1,$2,1,'succeeded','{}'::jsonb,null,$3::jsonb) as accepted", [jobId, worker, artifact]);
    assert.equal(completed.rows[0].accepted, true);
    const access = await db.query(`select session.expires_at >= artifact.expires_at as covered
      from public.access_sessions as session join public.jobs as job on job.owner_session_id=session.id
      join public.artifacts as artifact on artifact.job_id=job.id where job.id=$1`, [jobId]);
    assert.equal(access.rows[0].covered, true);
  } finally { await db.close(); }
});

test("migration enforces session and global queue capacity", async () => {
  const db = await database();
  try {
    const first = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('first',now()+interval '1 day') returning id");
    const owner = first.rows[0].id;
    const request = JSON.stringify({ selection: { content: "photos" } });
    const created = await db.query("select (public.enqueue_job($1,'photos',$2::jsonb)).id as id", [owner, request]);
    assert.ok(created.rows[0].id);
    await assert.rejects(db.query("select public.enqueue_job($1,'photos',$2::jsonb)", [owner, request]), /session_capacity/);

    for (let i = 0; i < 10; i++) {
      const session = await db.query("insert into public.access_sessions(token_hash,expires_at) values ($1,now()+interval '1 day') returning id", [`session-${i}`]);
      await db.query("select public.enqueue_job($1,'photos',$2::jsonb)", [session.rows[0].id, request]);
    }
    const extra = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('extra',now()+interval '1 day') returning id");
    await assert.rejects(db.query("select public.enqueue_job($1,'photos',$2::jsonb)", [extra.rows[0].id, request]), /global_capacity/);
  } finally { await db.close(); }
});

test("old lease generation cannot register artifacts or finish a newer attempt", async () => {
  const db = await database();
  try {
    const session = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('owner',now()+interval '1 day') returning id");
    const created = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [session.rows[0].id]);
    const jobId = created.rows[0].id;
    const firstWorker = "11111111-1111-4111-8111-111111111111";
    const secondWorker = "22222222-2222-4222-8222-222222222222";
    const first = await db.query("select (public.claim_job($1)).lease_generation as generation", [firstWorker]);
    assert.equal(first.rows[0].generation, 1);
    await db.query("update public.jobs set status='queued',lease_owner=null,lease_expires_at=null where id=$1", [jobId]);
    const second = await db.query("select (public.claim_job($1)).lease_generation as generation", [secondWorker]);
    assert.equal(second.rows[0].generation, 2);
    const oldHeartbeat = await db.query("select public.heartbeat_job($1,$2,1) as accepted", [jobId, firstWorker]);
    assert.equal(oldHeartbeat.rows[0].accepted, false);
    const oldProgress = await db.query("select public.progress_job($1,$2,1,'{}'::jsonb) as accepted", [jobId, firstWorker]);
    assert.equal(oldProgress.rows[0].accepted, false);
    const artifact = JSON.stringify([{ kind: "blog_zip", object_key: `${jobId}/2/blogs.zip`, mime_type: "application/zip", byte_size: 123 }]);
    const old = await db.query("select public.complete_job($1,$2,1,'succeeded','{}'::jsonb,null,$3::jsonb) as accepted", [jobId, firstWorker, artifact]);
    assert.equal(old.rows[0].accepted, false);
    const before = await db.query("select count(*)::int as count from public.artifacts where job_id=$1", [jobId]);
    assert.equal(before.rows[0].count, 0);
    const current = await db.query("select public.complete_job($1,$2,2,'succeeded','{}'::jsonb,null,$3::jsonb) as accepted", [jobId, secondWorker, artifact]);
    assert.equal(current.rows[0].accepted, true);
    const after = await db.query("select lease_generation,object_key from public.artifacts where job_id=$1", [jobId]);
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].lease_generation, 2);
  } finally { await db.close(); }
});

test("catalog requests are claimed by the worker and fenced by generation", async () => {
  const db = await database();
  try {
    const session = await db.query("insert into public.access_sessions(token_hash,expires_at) values ('catalog-owner',now()+interval '1 day') returning id");
    const queued = await db.query("select (public.enqueue_catalog_query($1,$2::jsonb)).id as id", [
      session.rows[0].id, JSON.stringify({ kind: "authors", group: "nogizaka" }),
    ]);
    const id = queued.rows[0].id;
    const worker = "33333333-3333-4333-8333-333333333333";
    const claimed = await db.query("select (public.claim_catalog_query($1)).lease_generation as generation", [worker]);
    assert.equal(claimed.rows[0].generation, 1);
    const rejected = await db.query("select public.complete_catalog_query($1,$2,0,$3::jsonb,null) as accepted", [id, worker, '{"authors":[]}']);
    assert.equal(rejected.rows[0].accepted, false);
    const done = await db.query("select public.complete_catalog_query($1,$2,1,$3::jsonb,null) as accepted", [id, worker, '{"authors":[]}']);
    assert.equal(done.rows[0].accepted, true);
    const result = await db.query("select status,result from public.catalog_queries where id=$1", [id]);
    assert.equal(result.rows[0].status, "succeeded");
    assert.deepEqual(result.rows[0].result, { authors: [] });
  } finally { await db.close(); }
});
