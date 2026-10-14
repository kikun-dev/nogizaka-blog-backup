---
name: issue-start
description: このリポジトリの GitHub Issue に着手するとき、完了条件と前提を確認し、1 Issue 専用ブランチと検証計画を用意する。
---

# Issue 着手

1. Issue 本文・コメント・関連 Issue を読み、完了条件と依存関係を整理する。未決定の仕様が結果を左右するなら、選択肢と推奨を提示して決定を待つ。
2. 現状のコードと差分を確認する。既存の未コミット変更は保護し、別 Issue の変更を混ぜない。
3. `origin/main` を確認し、`feature/<Issue番号>-<slug>`（修正は `fix/`、運用整備は `chore/`）の専用ブランチを作る。
4. 変更予定、完了条件ごとの検証方法、手動確認の要否を共有してから実装する。

このリポジトリの目標順序はローカル動作確認 → API の置き換え → 公開準備。後続 Issue の実装を先取りしない。GitHub 操作は `kikun-dev/nogizaka-blog-backup` を対象にする。
