import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function usage() {
  process.stderr.write("Usage: npm run access-codes -- create --name <label> [--expires-at <ISO date>] | list | revoke <uuid>\n");
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
if (!command || !["create", "list", "revoke"].includes(command)) usage();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  process.stderr.write("SUPABASE_URL と SUPABASE_SECRET_KEY が必要です。\n");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

try {
  if (command === "create") {
    let name;
    let expiresAt = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--name" && args[i + 1]) name = args[++i];
      else if (args[i] === "--expires-at" && args[i + 1]) expiresAt = args[++i];
      else usage();
    }
    if (!name?.trim() || name.trim().length > 120) usage();
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (!Number.isFinite(parsed.getTime()) || parsed <= new Date()) usage();
      expiresAt = parsed.toISOString();
    }
    const code = randomBytes(32).toString("base64url");
    const codeHash = createHash("sha256").update(code).digest("hex");
    const { data, error } = await db.rpc("admin_create_access_code", {
      p_code_hash: codeHash, p_display_name: name.trim(), p_expires_at: expiresAt,
    });
    if (error || !data?.[0]) throw new Error("発行できませんでした。");
    process.stdout.write(`${JSON.stringify({ ...data[0], code }, null, 2)}\n`);
  } else if (command === "list") {
    if (args.length) usage();
    const { data, error } = await db.rpc("admin_list_access_codes");
    if (error) throw new Error("一覧を取得できませんでした。");
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    if (args.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args[0])) usage();
    const { data, error } = await db.rpc("admin_revoke_access_code", { p_id: args[0] });
    if (error) throw new Error("失効できませんでした。");
    if (!data) throw new Error("コードが見つからないか、すでに失効しています。");
    process.stdout.write("アクセスコードを失効しました。\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "処理に失敗しました。"}\n`);
  process.exitCode = 1;
}
