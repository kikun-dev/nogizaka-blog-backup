import { LocalJobForm } from "./local-job-form";

export default function Home() {
  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="brand-mark" aria-hidden="true">坂</div>
        <div className="brand-name">坂道ブログ保存ツール</div>
        <span className="local-badge">LOCAL</span>
      </header>

      <div className="content">
        <LocalJobForm />
      </div>
      <footer className="site-footer">保存したファイルは、このパソコンの開発用フォルダに置かれます。</footer>
    </main>
  );
}
