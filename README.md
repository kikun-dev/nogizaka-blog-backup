# sakamichi-blog-backup

乃木坂46・櫻坂46・日向坂46の公式ブログ記事を、PDF と MHTML で保存するための Node.js スクリプトです。

保存先は指定した出力ルートの下に、グループ別フォルダとして作成されます。

- `Nogizaka/`
- `Sakurazaka/`
- `Hinatazaka/`

各グループ配下にはメンバー名のフォルダが作成され、記事ごとの `.pdf` と `.mhtml`、処理済み記事を記録する `index.json` が保存されます。

## Requirements

- Node.js 18+
- npm
- Playwright Chromium

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
npm run archive -- \
  --url 'https://www.nogizaka46.com/s/n46/diary/detail/記事ID' \
  --output '~/Documents/SakamichiBlogArchive'
```

WSL から Windows 側に保存する場合は、従来通り `/mnt/c/...` または `C:\...` 形式も指定できます。

開始URLからグループは自動判定されます。

対応URL例:

```text
https://www.nogizaka46.com/s/n46/diary/detail/104598?cd=MEMBER
https://sakurazaka46.com/s/s46/diary/detail/68997?cd=blog
https://www.hinatazaka46.com/s/official/diary/detail/69468?cd=member
```

主なオプション:

- `--limit 3`: 3記事だけ処理する
- `--delay 5000`: 記事間を5秒空ける
- `--headed`: ブラウザ画面を表示する
- `--force`: 既存ファイルを上書きする

## Check

```bash
npm run check
```
