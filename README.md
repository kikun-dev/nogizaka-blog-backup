# 坂道ブログ保存ツール

乃木坂46・櫻坂46・日向坂46の公式ブログ記事を保存するツールです。現在は Web アプリのローカル実装を進めています。Web 画面でグループ、メンバー、記事を順に選ぶと、既存 CLI がその記事を PDF と MHTML で保存します。メンバー欄には期別ブログ、運営スタッフ、ポカも含まれます。写真表示、ZIP 出力は今後の実装です。

## 必要な環境

- Node.js 24
- npm（Node.js 24 に付属する版）
- Playwright Chromium

## セットアップ

```bash
npm install
npx playwright install chromium
```

`.env.example` を参考に `.env.local` を作成し、`LOCAL_ACCESS_TOKEN` に推測されにくいランダムな値を設定してください。例: `openssl rand -hex 32`。この値は Git に登録せず、ブラウザの「ローカルアクセストークン」欄に入力します。

## ローカル Web アプリ

```bash
npm run dev
```

PC のブラウザで `http://localhost:3000` を開きます。アクセストークンを入力するとメンバー一覧が自動で読み込まれます。グループ→メンバー→記事を選んで「保存を開始」を押すと、1記事を `.local-data/archive/<jobId>/` に保存します。選択一覧は公式サイトの一覧ページを読み、5分間だけサーバー内でキャッシュします。記事本文を個別に開くのは保存を開始したときです。公式一覧にない記事は個別記事 URL を直接入力できます。

ジョブ状態は `.local-data/jobs/` に記録します。保存ファイルは `.local-data/archive/<jobId>/` に置きます。両フォルダは Git の管理対象外です。保存先を変えたい場合は `.env.local` へ `LOCAL_ARCHIVE_ROOT` を設定します。同時に実行する取得処理は1件、待機は最大10件です。サーバー再起動時に未完了だったジョブは、次の API アクセス時に失敗状態へ変更されます。

スマホで画面を確認する場合は、開発 PC とスマホを同じネットワークに接続し、スマホから `http://<開発PCのLAN内IPアドレス>:3000` を開いて同じアクセストークンを入力します。PC のファイアウォールが接続を遮断する場合は、ローカルネットワークからポート 3000 へのアクセスを許可してください。

写真の表示と長押し保存は現在の画面では未実装です。写真表示機能の実装後、iPhone は Safari で写真を長押しして「写真に保存」、Android は Chrome で写真を長押しして「画像をダウンロード」を選ぶ手順を確認します。実画面での操作手順と実機確認は Issue #5 の完了条件です。

## 既存 CLI

Web 化の間も従来の CLI を使用できます。

```bash
npm run archive -- \
  --url 'https://www.nogizaka46.com/s/n46/diary/detail/記事ID' \
  --output '~/Documents/SakamichiBlogArchive' \
  --limit 1
```

開始 URL からグループを自動判定します。投稿主体別の一覧ではなく、個別記事の URL を指定してください。主なオプションは `--limit 3`、`--delay 5000`、`--headed`、`--force` です。期別ブログやポカなども投稿主体別のフォルダに保存します。既存の `index.json` にある `memberName` は読み込み時に `authorName` として扱い、次の保存時に新形式へ移します。

## 共通取得エンジン

CLI は `lib/archive/index.mjs` の `archiveArticles()` を呼びます。同じモジュールの `inspectArticle()` は記事のタイトル・投稿主体・投稿日などを保存前に取得でき、Web サーバーからは `server/archive-engine.ts` 経由で両関数を呼べます。記事情報の確認では画像の読込状態をその時点の値として返し、PDF/MHTML 保存では従来どおり画像の読み込みを再試行します。

`lib/archive/` は、グループと URL、記事取得・メタデータ・画像、PDF/MHTML 生成、投稿主体別の索引・ファイル保存をモジュールごとに分けています。

## 開発用コマンド

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

ローカル実行役と取得処理の境界は `server/job-runner.ts` です。現在は共通エンジンを呼ぶ CLI を子プロセスとして起動します。公開時には Issue #9 で実行役を GitHub Actions worker に切り替えます。
