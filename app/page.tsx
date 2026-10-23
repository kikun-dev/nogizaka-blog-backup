import Image from "next/image";
import { LocalJobForm } from "./local-job-form";

export default function Home() {
  const publicMode = process.env.APP_MODE === "public" || process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  return (
    <main className="app-shell">
      <header className="site-header">
        <Image className="brand-mark" src="/icon.png" alt="" width={35} height={35} priority />
        <div className="brand-name">SakaClip<small>坂道ブログ保存ツール</small></div>
      </header>

      <div className="content">
        <LocalJobForm publicMode={publicMode} />
      </div>
      <footer className="site-footer">{publicMode ? "保存後は早めにダウンロードしてください。アプリでの期限は保存完了から24時間です。" : "保存したファイルは、このパソコンの開発用フォルダに置かれます。"} SakaClipは非公式の個人制作ツールです。</footer>
    </main>
  );
}
