import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

async function database({ legacySession = false } = {}) {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../supabase/migrations/20261021130000_public_jobs.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261022120000_service_role_table_privileges.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../supabase/migrations/20261023100000_cleanup_public_data.sql", import.meta.url), "utf8"));
  if (legacySession) await db.exec("insert into public.access_sessions(token_hash,expires_at) values ('legacy-token',now()+interval '1 day')");
  await db.exec(await readFile(new URL("../supabase/migrations/20261024100000_friend_access_codes.sql", import.meta.url), "utf8"));
  await db.exec("insert into public.access_codes(id,code_hash,display_name) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',repeat('a',64),'DB test')");
  return db;
}

const CODE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("service_role receives only required direct table privileges while RLS and RPC restrictions remain", async () => {
  const db = await database();
  try {
    const tables = ["access_sessions", "jobs", "artifacts", "worker_heartbeats", "catalog_queries", "access_codes", "access_login_attempts"];
    for (const table of tables) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const expected = ["access_sessions", "jobs", "artifacts", "worker_heartbeats", "catalog_queries"].includes(table)
            && (privilege === "SELECT" || (table === "access_sessions" && privilege === "INSERT"));
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
      ('access_sessions','jobs','artifacts','worker_heartbeats','catalog_queries','access_codes','access_login_attempts')`);
    assert.equal(rls.rows.length, tables.length);
    assert.ok(rls.rows.every((row) => row.relrowsecurity === true));

    const functions = [
      "enqueue_job(uuid,text,jsonb,uuid)", "recover_stale_jobs()", "claim_job(uuid)",
      "heartbeat_job(uuid,uuid,integer)", "progress_job(uuid,uuid,integer,jsonb,jsonb)",
      "complete_job(uuid,uuid,integer,text,jsonb,text,jsonb)", "enqueue_catalog_query(uuid,jsonb)",
      "claim_catalog_query(uuid)", "heartbeat_catalog_query(uuid,uuid,integer)",
      "complete_catalog_query(uuid,uuid,integer,jsonb,text)",
      "cleanup_expired_public_data()",
      "authenticate_access_code(text,text,text)", "find_access_session(text)",
      "admin_create_access_code(text,text,timestamp with time zone)", "admin_list_access_codes()", "admin_revoke_access_code(uuid)",
    ];
    for (const signature of functions) {
      for (const role of ["service_role", "anon", "authenticated"]) {
        const result = await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, `public.${signature}`]);
        assert.equal(result.rows[0].allowed, role === "service_role", `${role} EXECUTE ${signature}`);
      }
    }

    await db.exec("set role service_role");
    try {
      const created = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('service-session',$1,now()+interval '1 day') returning id", [CODE_ID]);
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

test("cleanup removes expired artifacts and unreferenced old owner data without exposing deletion privileges", async () => {
  const db = await database();
  try {
    const oldSession = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('cleanup-old',$1,now()-interval '2 days') returning id", [CODE_ID]);
    const recentSession = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('cleanup-current',$1,now()+interval '1 day') returning id", [CODE_ID]);
    const oldOwner = oldSession.rows[0].id;
    const currentOwner = recentSession.rows[0].id;
    const oldJob = await db.query(`insert into public.jobs(owner_session_id,kind,status,request,finished_at)
      values ($1,'blog','succeeded','{}',now()-interval '3 days') returning id`, [oldOwner]);
    const retryJob = await db.query(`insert into public.jobs(owner_session_id,kind,status,request,finished_at,retry_of_job_id)
      values ($1,'blog','failed','{}',now()-interval '3 days',$2) returning id`, [oldOwner, oldJob.rows[0].id]);
    const recentJob = await db.query(`insert into public.jobs(owner_session_id,kind,status,request,finished_at)
      values ($1,'blog','succeeded','{}',now()-interval '1 hour') returning id`, [currentOwner]);
    await db.query(`insert into public.artifacts(job_id,lease_generation,kind,object_key,mime_type,byte_size,expires_at)
      values ($1,1,'blog_zip',$2,'application/zip',1,now()-interval '1 hour'),
             ($3,1,'blog_zip',$4,'application/zip',1,now()+interval '1 day'),
             ($3,1,'photo_zip',$5,'application/zip',1,now()-interval '1 hour')`,
      [oldJob.rows[0].id, `${oldJob.rows[0].id}/1/blogs.zip`, recentJob.rows[0].id,
        `${recentJob.rows[0].id}/1/blogs.zip`, `${recentJob.rows[0].id}/1/photos.zip`]);
    await db.query(`insert into public.catalog_queries(owner_session_id,request,status,updated_at)
      values ($1,'{}','succeeded',now()-interval '3 days'),($2,'{}','succeeded',now())`, [oldOwner, currentOwner]);
    await db.query("insert into public.worker_heartbeats(worker_id,last_seen_at) values ('11111111-1111-4111-8111-111111111111',now()-interval '3 days')");

    await db.exec("set role service_role");
    try {
      await db.query("select public.cleanup_expired_public_data()");
      await assert.rejects(db.query("delete from public.artifacts"), /permission denied/);
    } finally { await db.exec("reset role"); }

    for (const table of ["jobs", "artifacts", "catalog_queries", "access_sessions", "worker_heartbeats"]) {
      const oldCount = await db.query(`select count(*)::int as count from public.${table}`);
      assert.equal(oldCount.rows[0].count, table === "worker_heartbeats" ? 0 : 1, table);
    }
    const kept = await db.query("select id from public.jobs");
    assert.equal(kept.rows[0].id, recentJob.rows[0].id);
    assert.ok(retryJob.rows[0].id);
  } finally { await db.close(); }
});

test("worker skips queued jobs after the owner session expires", async () => {
  const db = await database();
  try {
    const expiredSession = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('expired',$1,now()+interval '1 day') returning id", [CODE_ID]);
    const expiredOwner = expiredSession.rows[0].id;
    const oldJob = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [expiredOwner]);
    await db.query("update public.access_sessions set expires_at=now()-interval '1 second' where id=$1", [expiredOwner]);

    const currentSession = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('current',$1,now()+interval '1 day') returning id", [CODE_ID]);
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
    const session = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('near-expiry',$1,now()+interval '1 minute') returning id", [CODE_ID]);
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
    const first = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('first',$1,now()+interval '1 day') returning id", [CODE_ID]);
    const owner = first.rows[0].id;
    const request = JSON.stringify({ selection: { content: "photos" } });
    const created = await db.query("select (public.enqueue_job($1,'photos',$2::jsonb)).id as id", [owner, request]);
    assert.ok(created.rows[0].id);
    await assert.rejects(db.query("select public.enqueue_job($1,'photos',$2::jsonb)", [owner, request]), /session_capacity/);

    for (let i = 0; i < 10; i++) {
      const session = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ($1,$2,now()+interval '1 day') returning id", [`session-${i}`, CODE_ID]);
      await db.query("select public.enqueue_job($1,'photos',$2::jsonb)", [session.rows[0].id, request]);
    }
    const extra = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('extra',$1,now()+interval '1 day') returning id", [CODE_ID]);
    await assert.rejects(db.query("select public.enqueue_job($1,'photos',$2::jsonb)", [extra.rows[0].id, request]), /global_capacity/);
  } finally { await db.close(); }
});

test("old lease generation cannot register artifacts or finish a newer attempt", async () => {
  const db = await database();
  try {
    const session = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('owner',$1,now()+interval '1 day') returning id", [CODE_ID]);
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
    const session = await db.query("insert into public.access_sessions(token_hash,access_code_id,expires_at) values ('catalog-owner',$1,now()+interval '1 day') returning id", [CODE_ID]);
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

test("legacy sessions are expired in place and cannot be extended during the app rollout", async () => {
  const db = await database({ legacySession: true });
  try {
    const legacy = await db.query("select id,expires_at,access_code_id from public.access_sessions where token_hash='legacy-token'");
    assert.equal(legacy.rows[0].access_code_id, null);
    assert.ok(new Date(legacy.rows[0].expires_at).getTime() <= Date.now());
    await db.query("update public.access_sessions set expires_at=now()+interval '1 day' where id=$1", [legacy.rows[0].id]);
    const stillExpired = await db.query("select expires_at<=now() as expired from public.access_sessions where id=$1", [legacy.rows[0].id]);
    assert.equal(stillExpired.rows[0].expired, true);
    const found = await db.query("select public.find_access_session(repeat('0',64)) as id");
    assert.equal(found.rows[0].id, null);
    await assert.rejects(db.query("select public.enqueue_job($1,'blog','{}'::jsonb)", [legacy.rows[0].id]), /session_expired/);
  } finally { await db.close(); }
});

test("code creation stores only a hash and login creates an expiring code-bound session", async () => {
  const db = await database();
  try {
    const secret = "example-friend-code-that-is-never-stored";
    const hash = (await import("node:crypto")).createHash("sha256").update(secret).digest("hex");
    const created = await db.query(`select * from public.admin_create_access_code($1,'Friend One',now()+interval '2 days')`, [hash]);
    const listed = await db.query("select * from public.admin_list_access_codes() where id=$1", [created.rows[0].id]);
    assert.equal("code_hash" in listed.rows[0], false);
    assert.equal("code_hash" in created.rows[0], false);
    const stored = await db.query("select code_hash from public.access_codes where id=$1", [created.rows[0].id]);
    assert.equal(stored.rows[0].code_hash, hash);
    assert.notEqual(stored.rows[0].code_hash, secret);
    const tokenHash = "e".repeat(64);
    const rateKey = "f".repeat(64);
    const login = await db.query("select public.authenticate_access_code($1,$2,$3) as id", [hash, tokenHash, rateKey]);
    assert.ok(login.rows[0].id);
    const found = await db.query("select public.find_access_session($1) as id", [tokenHash]);
    assert.equal(found.rows[0].id, login.rows[0].id);
    const exp = await db.query(`select s.expires_at<c.expires_at as capped from public.access_sessions s
      join public.access_codes c on c.id=s.access_code_id where s.id=$1`, [login.rows[0].id]);
    assert.equal(exp.rows[0].capped, true);
    const job = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [login.rows[0].id]);
    const query = await db.query("select (public.enqueue_catalog_query($1,'{\"kind\":\"authors\",\"group\":\"nogizaka\"}'::jsonb)).id as id", [login.rows[0].id]);
    await db.query("update public.access_codes set created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' where id=$1", [created.rows[0].id]);
    const expired = await db.query("select public.find_access_session($1) as id", [tokenHash]);
    assert.equal(expired.rows[0].id, null);
    await db.query("update public.access_sessions set expires_at=now()+interval '1 day' where id=$1", [login.rows[0].id]);
    const cappedExpired = await db.query("select expires_at<=now() as expired from public.access_sessions where id=$1", [login.rows[0].id]);
    assert.equal(cappedExpired.rows[0].expired, true);
    assert.equal((await db.query("select (public.claim_job('99999999-9999-4999-8999-999999999999')).id as id")).rows[0].id, null);
    assert.equal((await db.query("select status from public.jobs where id=$1", [job.rows[0].id])).rows[0].status, "failed");
    assert.equal((await db.query("select (public.claim_catalog_query('99999999-9999-4999-8999-999999999999')).id as id")).rows[0].id, null);
    assert.equal((await db.query("select status from public.catalog_queries where id=$1", [query.rows[0].id])).rows[0].status, "failed");
  } finally { await db.close(); }
});

test("parallel failed logins share an atomic rate limit without code enumeration", async () => {
  const db = await database();
  try {
    const codeHash = "1".repeat(64);
    const rateKey = "2".repeat(64);
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.query(
      "select public.authenticate_access_code($1,$2,$3) as id", [codeHash, String(i + 10).padStart(64, "0"), rateKey],
    )));
    const attempt = await db.query("select failed_attempts,blocked_until>now() as blocked from public.access_login_attempts where rate_key=$1", [rateKey]);
    assert.equal(attempt.rows[0].failed_attempts, 10);
    assert.equal(attempt.rows[0].blocked, true);
    const validHash = "3".repeat(64);
    await db.query("select public.admin_create_access_code($1,'Friend',null)", [validHash]);
    const blockedValid = await db.query("select public.authenticate_access_code($1,$2,$3) as id", [validHash, "4".repeat(64), rateKey]);
    assert.equal(blockedValid.rows[0].id, null);
  } finally { await db.close(); }
});

test("revocation expires sessions and fences queued and running job work without deleting history", async () => {
  const db = await database();
  try {
    const hash = "5".repeat(64);
    const code = await db.query("select * from public.admin_create_access_code($1,'Revoked Friend',null)", [hash]);
    const login = await db.query("select public.authenticate_access_code($1,$2,$3) as id", [hash, "6".repeat(64), "7".repeat(64)]);
    const owner = login.rows[0].id;
    const queued = await db.query("select (public.enqueue_job($1,'blog','{}'::jsonb)).id as id", [owner]);
    const worker = "88888888-8888-4888-8888-888888888888";
    const claimed = await db.query("select (public.claim_job($1)).lease_generation as generation", [worker]);
    assert.equal(claimed.rows[0].generation, 1);
    const revoked = await db.query("select public.admin_revoke_access_code($1) as revoked", [code.rows[0].id]);
    assert.equal(revoked.rows[0].revoked, true);
    const session = await db.query("select expires_at<=now() as expired from public.access_sessions where id=$1", [owner]);
    assert.equal(session.rows[0].expired, true);
    const job = await db.query("select status,lease_generation from public.jobs where id=$1", [queued.rows[0].id]);
    assert.equal(job.rows[0].status, "failed");
    assert.equal(job.rows[0].lease_generation, 2);
    assert.equal((await db.query("select public.heartbeat_job($1,$2,1) as ok", [queued.rows[0].id, worker])).rows[0].ok, false);
    const artifact = JSON.stringify([{ kind: "blog_zip", object_key: `${queued.rows[0].id}/1/blogs.zip`, mime_type: "application/zip", byte_size: 1 }]);
    assert.equal((await db.query("select public.complete_job($1,$2,1,'succeeded','{}'::jsonb,null,$3::jsonb) as ok", [queued.rows[0].id, worker, artifact])).rows[0].ok, false);
    await assert.rejects(db.query("select public.enqueue_job($1,'blog','{}'::jsonb)", [owner]), /session_expired/);
    await assert.rejects(db.query("select public.enqueue_job($1,'blog','{}'::jsonb,$2)", [owner, queued.rows[0].id]), /session_expired/);
    assert.equal((await db.query("select count(*)::int as count from public.jobs where id=$1", [queued.rows[0].id])).rows[0].count, 1);
    assert.equal((await db.query("select count(*)::int as count from public.artifacts where job_id=$1", [queued.rows[0].id])).rows[0].count, 0);
  } finally { await db.close(); }
});
