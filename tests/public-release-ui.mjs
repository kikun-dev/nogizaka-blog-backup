import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "playwright";

const firstId = "11111111-1111-4111-8111-111111111111";
const retryId = "22222222-2222-4222-8222-222222222222";
const now = new Date().toISOString();

function job(status, overrides = {}) {
  return {
    id: firstId, kind: "blog", status, createdAt: now, updatedAt: now,
    outputDirectory: "", log: [], savedCount: 0, blogZipReady: false,
    requestedArticles: [], articleResults: [], ...overrides,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startApp() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, APP_MODE: "public", NEXT_TELEMETRY_DISABLED: "1",
      SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SECRET_KEY: "ui-test-only",
      R2_ACCOUNT_ID: "ui-test", R2_BUCKET_NAME: "ui-test",
      R2_ACCESS_KEY_ID: "ui-test", R2_SECRET_ACCESS_KEY: "ui-test",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`UI test server exited: ${output}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return { origin, child };
    } catch { /* Wait for the local development server. */ }
    await delay(250);
  }
  child.kill();
  throw new Error(`UI test server did not start: ${output}`);
}

async function withApp(run) {
  const app = await startApp();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    await run(app.origin, browser);
  } finally {
    await browser?.close();
    app.child.kill();
  }
}

async function pageFor(browser, origin, handler) {
  const page = await browser.newPage();
  await page.addInitScript((id) => localStorage.setItem("sakamichi-public-recent-job", id), firstId);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const response = await handler(url.pathname, route.request().method());
    await route.fulfill({ status: response.status ?? 200, contentType: "application/json", body: JSON.stringify(response.body) });
  });
  await page.goto(origin);
  return page;
}

test("public UI shows worker downtime and clears it after heartbeat recovery", async () => {
  await withApp(async (origin, browser) => {
    let workerOffline = true;
    const page = await pageFor(browser, origin, (path) => {
      if (path === "/api/access-session") return { body: { authenticated: true } };
      if (path === `/api/jobs/${firstId}`) return { body: { job: job("queued"), workerOffline } };
      if (path.startsWith("/api/catalog/")) return { body: { authors: [] } };
      throw new Error(`Unexpected API request: ${path}`);
    });
    await page.getByText("ワーカーが停止中です。開始までお待ちください。").waitFor();
    workerOffline = false;
    await page.reload();
    await page.getByText("開始待ち", { exact: true }).waitFor();
    assert.equal(await page.getByText("ワーカーが停止中です。開始までお待ちください。").count(), 0);
    await page.close();
  });
});

test("a previously logged-in screen explains session expiry after HTTP 401", async () => {
  await withApp(async (origin, browser) => {
    let expired = false;
    const page = await pageFor(browser, origin, (path) => {
      if (path === "/api/access-session") return { body: { authenticated: true } };
      if (path === `/api/jobs/${firstId}`) {
        return expired ? { status: 401, body: { error: "アクセスコードを入力してください。" } }
          : { body: { job: job("queued"), workerOffline: false } };
      }
      if (path.startsWith("/api/catalog/")) return { body: { authors: [] } };
      throw new Error(`Unexpected API request: ${path}`);
    });
    await page.getByText("開始待ち", { exact: true }).waitFor();
    expired = true;
    const alert = page.getByRole("region", { name: "取得条件を決める" }).getByRole("alert");
    await alert.waitFor();
    assert.equal(await alert.textContent(), "アクセスの期限が切れました。アクセスコードをもう一度入力してください。");
    assert.equal(await page.getByLabel("あなたのアクセスコード").isVisible(), true);
    await page.close();
  });
});

test("partial failure, retry, and completion are distinguishable in the public UI", async () => {
  await withApp(async (origin, browser) => {
    const partial = job("partial", {
      savedCount: 1, blogZipReady: true,
      requestedArticles: [{ id: "one" }, { id: "two" }],
      articleResults: [
        { id: "one", title: "保存済み", date: "", status: "succeeded" },
        { id: "two", title: "失敗した記事", date: "", status: "failed", message: "取得できませんでした" },
      ],
    });
    const queued = job("queued", { id: retryId, retryOfJobId: firstId, requestedArticles: [{ id: "two" }] });
    const done = job("succeeded", {
      id: retryId, retryOfJobId: firstId, savedCount: 1, blogZipReady: true,
      requestedArticles: [{ id: "two" }],
      articleResults: [{ id: "two", title: "失敗した記事", date: "", status: "succeeded" }],
    });
    let retries = 0;
    let firstStatus = partial;
    const page = await pageFor(browser, origin, (path, method) => {
      if (path === "/api/access-session") return { body: { authenticated: true } };
      if (path === `/api/jobs/${firstId}`) return { body: { job: firstStatus } };
      if (path === `/api/jobs/${firstId}/retry` && method === "POST") { retries++; return { status: 202, body: { job: queued } }; }
      if (path === `/api/jobs/${retryId}`) return { body: { job: done } };
      if (path.startsWith("/api/catalog/")) return { body: { authors: [] } };
      throw new Error(`Unexpected API request: ${path}`);
    });
    await page.getByText("一部を保存しました").waitFor();
    await page.getByText("成功 1 件 / 失敗 1 件").waitFor();
    await page.getByText("失敗した記事（投稿日不明）: 取得できませんでした").waitFor();
    await page.getByRole("button", { name: "失敗した記事だけ再試行" }).click();
    await page.getByText("失敗した記事の再試行結果です。").waitFor();
    await page.getByText("保存しました", { exact: true }).waitFor();
    assert.equal(retries, 1);
    assert.equal(await page.getByText("成功 1 件 / 失敗 0 件").isVisible(), true);
    await page.close();

    firstStatus = job("failed", { error: "ワーカーの処理が失敗しました。" });
    const failedPage = await pageFor(browser, origin, (path) => {
      if (path === "/api/access-session") return { body: { authenticated: true } };
      if (path === `/api/jobs/${firstId}`) return { body: { job: firstStatus } };
      if (path.startsWith("/api/catalog/")) return { body: { authors: [] } };
      throw new Error(`Unexpected API request: ${path}`);
    });
    await failedPage.getByText("保存できませんでした", { exact: true }).waitFor();
    await failedPage.getByText("ワーカーの処理が失敗しました。").waitFor();
    await failedPage.close();
  });
});
