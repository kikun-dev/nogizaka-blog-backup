<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 開発フロー

- 実装は GitHub Issue を起点にし、原則 1 Issue = 1 PR とする。別件の変更は別 Issue / PR に分ける。
- 着手前に Issue の完了条件を読み、PR には条件ごとの達成状況と検証結果を書く。未達・未検証は明記する。
- 各 PR はユーザーのレビューを必ず挟む。レビューへの対応と完了条件の再確認が終わるまでマージせず、次の機能 Issue に進まない。
- この運用の詳細は `.agents/skills/issue-start/`、`.agents/skills/pr/`、`.agents/skills/pr-review/` を参照する。
- この作業環境の `.git` がプレースホルダーの場合、Git 操作には `git --git-dir=.repo.git --work-tree=.` を使う。通常の clone では通常の `git` を使う。
