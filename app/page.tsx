import { LocalJobForm } from "./local-job-form";

export default function Home() {
  const publicMode = process.env.APP_MODE === "public" || process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="brand-mark" aria-hidden="true">坂</div>
        <div className="brand-name">坂道ブログ保存ツール</div>
        <span className="local-badge">{publicMode ? "WEB" : "LOCAL"}</span>
      </header>

      <div className="content">
        <LocalJobForm publicMode={publicMode} />
      </div>
      <footer className="site-footer">{publicMode ? "保存後は早めにダウンロードしてください。アプリでの期限は保存完了から24時間です。" : "保存したファイルは、このパソコンの開発用フォルダに置かれます。"}</footer>
    </main>
  );
}
