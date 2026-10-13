# 坂道ブログ保存ツール

乃木坂46・櫻坂46・日向坂46の公式ブログ記事を保存するツールです。現在は Web アプリのローカル実装を進めています。Web 画面から個別記事 URL を指定すると、既存 CLI がその記事を PDF と MHTML で保存します。ブログ主体選択、写真表示、ZIP 出力は今後の実装です。

## 必要な環境

- Node.js 24
- npm（Node.js 24 に付属する版）
- Playwright Chromium

## セットアップ

```bash
npm install
npx playwright install chromium
```

## ローカル Web アプリ

```bash
npm run dev
```

PC のブラウザで `http://localhost:3000` を開きます。公式ブログの個別記事 URL を入力して「保存を開始」を押すと、1記事を `.local-data/archive/<jobId>/` に保存します。ジョブ状態は `.local-data/jobs/` に記録します。両フォルダは Git の管理対象外です。保存先を変えたい場合は `.env.example` を参考に `.env.local` へ `LOCAL_ARCHIVE_ROOT` を設定します。

スマホで画面を確認する場合は、開発 PC とスマホを同じネットワークに接続し、スマホから `http://<開発PCのLAN内IPアドレス>:3000` を開きます。PC のファイアウォールが接続を遮断する場合は、ローカルネットワークからポート 3000 へのアクセスを許可してください。iPhone Safari と Android Chrome での写真長押し保存は、写真表示機能の実装後にこの方法で確認します。

## 既存 CLI

Web 化の間も従来の CLI を使用できます。

```bash
npm run archive -- \
  --url 'https://www.nogizaka46.com/s/n46/diary/detail/記事ID' \
  --output '~/Documents/SakamichiBlogArchive' \
  --limit 1
```

開始 URL からグループを自動判定します。メンバー別一覧ではなく、個別記事の URL を指定してください。主なオプションは `--limit 3`、`--delay 5000`、`--headed`、`--force` です。

## 開発用コマンド

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

ローカル実行役と取得処理の境界は `server/job-runner.ts` です。現在は既存 CLI を子プロセスとして起動します。後続の Issue #2 で取得エンジンを分離し、公開時には Issue #9 で実行役を GitHub Actions worker に切り替えます。
