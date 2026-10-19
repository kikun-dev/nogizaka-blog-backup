"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LocalJob } from "@/server/job-store";
import type { SelectionRequest } from "@/lib/selection";
import { AcquisitionPlanner } from "./acquisition-planner";
import { PhotoGallery } from "./photo-gallery";

const statusLabel = {
  queued: "開始待ち",
  running: "保存中",
  succeeded: "保存しました",
  failed: "保存できませんでした",
} as const;

export function LocalJobForm() {
  const [view, setView] = useState<"setup" | "photos">("setup");
  const [url, setUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [readyToken, setReadyToken] = useState("");
  const [job, setJob] = useState<LocalJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const previousView = useRef(view);
  const setupRef = useRef<HTMLElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousPhotoStatus = useRef<LocalJob["status"] | undefined>(undefined);
  const activeJobId = job?.id;
  const activeStatus = job?.status;
  const busy = submitting || activeStatus === "queued" || activeStatus === "running";

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const section = view === "photos"
      ? job?.kind === "photos" && job.photoArticles ? galleryRef.current : resultRef.current
      : setupRef.current;
    const heading = view === "photos" ? resultHeadingRef.current : setupHeadingRef.current;
    const frame = window.requestAnimationFrame(() => section?.scrollIntoView({ block: "start", behavior: "auto" }));
    heading?.focus({ preventScroll: true });
    return () => window.cancelAnimationFrame(frame);
  }, [view, job?.kind, job?.photoArticles]);

  useEffect(() => {
    const status = job?.kind === "photos" ? job.status : undefined;
    let frame: number | undefined;
    if (view === "photos" && job?.kind === "photos" && job.photoArticles
      && (status === "succeeded" || status === "failed") && previousPhotoStatus.current !== status) {
      frame = window.requestAnimationFrame(() => galleryRef.current?.scrollIntoView({ block: "start", behavior: "auto" }));
    }
    previousPhotoStatus.current = status;
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); };
  }, [job, view]);

  useEffect(() => {
    if (!accessToken) return;
    const timer = window.setTimeout(() => setReadyToken(accessToken), 600);
    return () => window.clearTimeout(timer);
  }, [accessToken]);

  useEffect(() => {
    if (!activeJobId || (activeStatus !== "queued" && activeStatus !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${activeJobId}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) throw new Error("状態を確認できませんでした。画面を再読み込みしてください。");
        const data = await response.json() as { job: LocalJob };
        setJob(data.job);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "状態を確認できませんでした。");
        window.clearInterval(timer);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeJobId, activeStatus, accessToken]);

  async function submitJob(articleUrl: string) {
    if (busy) return;
    if (!accessToken) {
      setMessage("ローカルアクセストークンを入力してください。");
      return;
    }
    setUrl(articleUrl);
    setSubmitting(true);
    setMessage("");
    setJob(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ url: articleUrl }),
      });
      const data = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error ?? "開始できませんでした。");
      setJob(data.job);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "開始できませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPhotoJob(selection: SelectionRequest) {
    if (busy) return;
    setView("photos");
    setSubmitting(true);
    setMessage("");
    setJob(null);
    try {
      const response = await fetch("/api/photo-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(selection),
      });
      const data = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error ?? "写真の取得を開始できませんでした。");
      setJob(data.job);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "写真の取得を開始できませんでした。");
    } finally { setSubmitting(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitJob(url);
  }

  return (
    <>
    {view === "setup" && <div className="intro">
      <p className="intro-caption">坂道46 公式ブログ</p>
      <h1>大切なブログを、<br className="mobile-break" />手元に残す。</h1>
      <p>
        乃木坂46・櫻坂46・日向坂46の公式ブログを保存するためのツールです。
        公式サイトの一覧からメンバーと取得範囲を選べます。写真の閲覧・保存と、ブログ1件の保存ができます。
      </p>
    </div>}
    <section ref={setupRef} className="workspace" aria-labelledby="workspace-title" hidden={view !== "setup"}>
      <div className="workspace-heading">
        <div><h2 ref={setupHeadingRef} id="workspace-title" tabIndex={-1}>取得条件を決める</h2></div>
        <span className="phase-badge">ローカル版</span>
      </div>
      <p className="workspace-description">メンバーを選んで、保存する内容とブログの範囲を決めます。</p>
      {job?.kind === "photos" && <button type="button" className="secondary-button photo-reopen" onClick={() => setView("photos")}>写真の取得結果を見る</button>}
      <div className="token-field">
        <label htmlFor="access-token">ローカルアクセストークン</label>
        <input id="access-token" type="password" autoComplete="off" value={accessToken} onChange={(event) => { setAccessToken(event.target.value); setReadyToken(""); }} aria-describedby="token-help" />
        <p id="token-help" className="field-help">開発PCの .env.local に設定したトークンを入力してください。</p>
      </div>

      {readyToken ? <AcquisitionPlanner token={readyToken} busy={busy} onSaveBlog={submitJob} onSavePhotos={submitPhotoJob} />
        : <p className="selection-start-help">トークンを入力すると取得条件を選べます。</p>}

      <form onSubmit={submit} className="job-form direct-url-form">
        <h3>ブログの個別URLで1件保存</h3>
        <p className="field-help">公式一覧にないブログはURLを直接入力できます。PDFとMHTMLを保存します。</p>
        <label htmlFor="article-url">ブログの個別URL</label>
        <div className="input-row">
          <input id="article-url" type="url" inputMode="url" autoComplete="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.nogizaka46.com/s/n46/diary/detail/..." />
          <button type="submit" disabled={busy}>{submitting ? "開始中…" : "保存を開始"}</button>
        </div>
      </form>

      {message && job?.kind !== "photos" && <p className="form-message" role="alert">{message}</p>}
      {job && job.kind !== "photos" && (
        <div className="job-result" aria-live="polite">
          <div className="job-result-top"><strong>{statusLabel[job.status]}</strong><span className={`status-dot status-${job.status}`} aria-hidden="true" /></div>
          {job.status === "succeeded" && <p>保存先: <code>{job.outputDirectory}</code></p>}
          {job.error && <p className="form-message">{job.error}</p>}
          {job.log.length > 0 && <details><summary>処理ログを確認</summary><pre>{job.log.join("\n")}</pre></details>}
        </div>
      )}
    </section>
    {view === "setup" && <div className="next-step">
      <span className="next-step-title">これから追加する機能</span>
      <p>複数件のブログと全件バックアップの実行を順に実装します。</p>
    </div>}
    <section ref={resultRef} className="workspace photo-result-screen" aria-labelledby="photo-result-title" hidden={view !== "photos"}>
      <div className="photo-screen-nav">
        <button type="button" className="secondary-button" onClick={() => setView("setup")}>条件設定に戻る</button>
        <span className="phase-badge">写真のみ</span>
      </div>
      <h2 ref={resultHeadingRef} id="photo-result-title" tabIndex={-1} aria-live="polite">{job?.kind === "photos" && job.status === "succeeded" ? "取得した写真" : "写真の取得結果"}</h2>
      {submitting && <p className="photo-screen-message" role="status">写真の取得を開始しています…</p>}
      {message && <p className="form-message" role="alert">{message}</p>}
      {job?.kind === "photos" && job.status !== "succeeded" && <div className="job-result" aria-live="polite">
        <div className="job-result-top"><strong>{job.status === "running" ? "写真を取得中" : statusLabel[job.status]}</strong><span className={`status-dot status-${job.status}`} aria-hidden="true" /></div>
        {(job.status === "queued" || job.status === "running") && <p>写真を取得しています。完了するとこの画面に表示します。</p>}
        {job.error && <p className="form-message">{job.error}</p>}
      </div>}
      {job?.kind === "photos" && job.photoArticles && <div ref={galleryRef} className="photo-gallery-anchor"><PhotoGallery job={job} /></div>}
      {job?.kind === "photos" && job.photoArticles && <button type="button" className="secondary-button photo-back-bottom" onClick={() => setView("setup")}>条件設定に戻る</button>}
    </section>
    </>
  );
}
