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
        <div className="intro">
          <p className="intro-caption">坂道46 公式ブログ</p>
          <h1>大切な記事を、<br className="mobile-break" />手元に残す。</h1>
          <p>
            乃木坂46・櫻坂46・日向坂46の公式ブログを保存するためのツールです。
            公式サイトの一覧から記事を選び、1件ずつ保存するローカル機能を試せます。
          </p>
        </div>

        <LocalJobForm />

        <div className="next-step">
          <span className="next-step-title">これから追加する機能</span>
          <p>写真の表示と長押し保存、記事の一括取得を順に実装します。</p>
        </div>
      </div>
      <footer className="site-footer">保存したファイルは、このパソコンの開発用フォルダに置かれます。</footer>
    </main>
  );
}
