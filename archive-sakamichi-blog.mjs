import { archiveArticles } from "./lib/archive/index.mjs";

const DEFAULT_LIMIT = 10_000;
const DEFAULT_DELAY_MS = 3_000;

function usage() {
  console.log(`
使い方:
  node archive-sakamichi-blog.mjs \\
    --url '最新ブログURL' \\
    --output '~/Documents/SakamichiBlogArchive'

オプション:
  --limit 3     3件だけ処理する
  --delay 5000  ブログ間を5秒空ける（既定: 3000ms）
  --headed      ブラウザ画面を表示する
  --force       既存ファイルを上書きする
`);
}

function parseArgs(argv) {
  const options = {
    url: "",
    output: "",
    limit: DEFAULT_LIMIT,
    delay: DEFAULT_DELAY_MS,
    headed: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--url":
        options.url = argv[++i] ?? "";
        break;

      case "--output":
        options.output = argv[++i] ?? "";
        break;

      case "--limit":
        options.limit = Number.parseInt(argv[++i] ?? "", 10);
        break;

      case "--delay":
        options.delay = Number.parseInt(argv[++i] ?? "", 10);
        break;

      case "--headed":
        options.headed = true;
        break;

      case "--force":
        options.force = true;
        break;

      case "--help":
      case "-h":
        usage();
        process.exit(0);

      default:
        throw new Error(`不明なオプションです: ${argv[i]}`);
    }
  }

  if (!options.url || !options.output) {
    usage();
    throw new Error("--url と --output は必須です。");
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("--limit は1以上の整数にしてください。");
  }

  if (!Number.isInteger(options.delay) || options.delay < 1_000) {
    throw new Error("--delay は1000以上にしてください。");
  }

  return options;
}

archiveArticles(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(`\nエラー: ${error.message}`);
  if (error.showRetryHint !== false) {
    console.error("同じコマンドを再実行すると、保存済みファイルを飛ばして続行できます。");
  }
  process.exitCode = 1;
});
