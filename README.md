# nogizaka-blog-backup

乃木坂46公式ブログの記事を、メンバーごとに PDF と MHTML で保存するための Node.js スクリプトです。

## Requirements

- Node.js 18+
- npm
- Playwright Chromium
- WSL から Windows 側の保存先に書き込める環境

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

```bash
npm run archive -- \
  --url 'https://www.nogizaka46.com/s/n46/diary/detail/記事ID' \
  --output '/mnt/c/Users/Windowsユーザー名/Documents/NogizakaBlogArchive'
```

主なオプション:

- `--limit 3`: 3記事だけ処理する
- `--delay 5000`: 記事間を5秒空ける
- `--headed`: ブラウザ画面を表示する
- `--force`: 既存ファイルを上書きする

保存先にはメンバー名のフォルダが作成され、各記事の `.pdf` と `.mhtml`、処理済み記事を記録する `index.json` が保存されます。

## Check

```bash
npm run check
```
