import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

async function database() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(await readFile(new URL("../supabase/migrations/20261021130000_public_jobs.sql", import.meta.url), "utf8"));
  return db;
}

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
