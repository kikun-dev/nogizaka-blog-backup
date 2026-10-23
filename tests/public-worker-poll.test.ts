import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidClaimResponseError, parseClaimedCatalogQuery, parseClaimedJob } from "../server/public-store";
import { errorDiagnostic } from "../worker/diagnostics";
import { pollOnce } from "../worker/poll";

const workerId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const emptyComposite = {
  id: null, owner_session_id: null, status: null, request: null,
  lease_owner: null, lease_generation: null,
};

test("empty job claim waits and never starts acquisition", async () => {
  let runs = 0;
  for (const data of [null, [], [null], emptyComposite, [emptyComposite]]) {
    const handled = await pollOnce(async () => parseClaimedJob(data, workerId), async () => { runs++; });
    assert.equal(handled, false);
  }
  assert.equal(runs, 0);
  assert.throws(() => parseClaimedJob({ ...emptyComposite, status: "running" }, workerId), InvalidClaimResponseError);
  assert.throws(() => parseClaimedJob({ id, status: "running" }, workerId), InvalidClaimResponseError);
  assert.throws(() => parseClaimedJob({
    id, owner_session_id: ownerId, status: "running", kind: "blog", request: {},
    lease_owner: workerId, lease_generation: 1,
  }, workerId), InvalidClaimResponseError);

  const valid = {
    id, owner_session_id: ownerId, status: "running", kind: "blog",
    request: { selection: {} }, lease_owner: workerId, lease_generation: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  assert.equal(await pollOnce(async () => parseClaimedJob(valid, workerId), async (row) => {
    assert.equal(row.id, id);
    runs++;
  }), true);
  assert.equal(runs, 1);
});

test("empty catalog claim waits and malformed rows cannot start Playwright", async () => {
  let runs = 0;
  for (const data of [null, [], [null], emptyComposite, [emptyComposite]]) {
    const handled = await pollOnce(async () => parseClaimedCatalogQuery(data, workerId), async () => { runs++; });
    assert.equal(handled, false);
  }
  assert.equal(runs, 0);
  assert.throws(() => parseClaimedCatalogQuery({ ...emptyComposite, id }, workerId), InvalidClaimResponseError);
  assert.throws(() => parseClaimedCatalogQuery([{ ...emptyComposite }, { ...emptyComposite }], workerId), InvalidClaimResponseError);
  assert.throws(() => parseClaimedCatalogQuery({
    id, owner_session_id: ownerId, status: "running", request: {}, lease_owner: workerId, lease_generation: 1,
  }, workerId), InvalidClaimResponseError);

  const valid = {
    id, owner_session_id: ownerId, status: "running", request: { kind: "authors", group: "nogizaka" },
    lease_owner: workerId, lease_generation: 1,
  };
  assert.equal(await pollOnce(async () => parseClaimedCatalogQuery(valid, workerId), async (row) => {
    assert.equal(row.id, id);
    runs++;
  }), true);
  assert.equal(runs, 1);
});

test("worker diagnostics retain error codes while redacting configured secrets", () => {
  const previous = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = "test-secret-value-123";
  try {
    const error = Object.assign(new Error("request failed with test-secret-value-123 at https://db.example/path?apikey=key"), {
      code: "PGRST202",
    });
    const diagnostic = errorDiagnostic(error);
    assert.equal(diagnostic.errorCode, "PGRST202");
    assert.match(diagnostic.errorMessage ?? "", /request failed/);
    assert.doesNotMatch(diagnostic.errorMessage ?? "", /test-secret-value-123|apikey=key/);
    const network = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }),
    });
    assert.equal(errorDiagnostic(network).errorCode, "ENOTFOUND");
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = previous;
  }
});
