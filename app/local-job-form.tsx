"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LocalJob } from "@/server/job-store";
import { validateSelection, type SelectionRequest } from "@/lib/selection";
import { AcquisitionPlanner } from "./acquisition-planner";
import { PhotoGallery } from "./photo-gallery";

const statusLabel = {
  queued: "開始待ち",
  running: "保存中",
  succeeded: "保存しました",
  failed: "保存できませんでした",
} as const;

export function LocalJobForm() {
  const [view, setView] = useState<"setup" | "photos" | "blog">("setup");
  const [url, setUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [readyToken, setReadyToken] = useState("");
  const [job, setJob] = useState<LocalJob | null>(null);
  const [bulkSelection, setBulkSelection] = useState<SelectionRequest | null>(null);
  const [savedBulkJobId, setSavedBulkJobId] = useState("");
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
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem("sakamichi-bulk-job");
        if (saved) setSavedBulkJobId((JSON.parse(saved) as { id?: string }).id ?? "");
      } catch { window.localStorage.removeItem("sakamichi-bulk-job"); }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const section = view === "photos"
      ? job?.kind === "photos" && job.photoArticles ? galleryRef.current : resultRef.current
      : setupRef.current;
    const target = view === "blog" ? resultRef.current : section;
    const heading = view === "setup" ? setupHeadingRef.current : resultHeadingRef.current;
    const frame = window.requestAnimationFrame(() => target?.scrollIntoView({ block: "start", behavior: "auto" }));
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
    setBulkSelection(null);
    setView("blog");
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

  async function submitBlogJob(selection: SelectionRequest) {
    if (busy) return;
    setBulkSelection(selection.range === "all" ? selection : null);
    setView("blog");
    setSubmitting(true);
    setMessage("");
    setJob(null);
    try {
      const response = await fetch("/api/blog-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(selection),
      });
      const data = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error ?? "ブログの保存を開始できませんでした。");
      setJob(data.job);
      if (selection.range === "all") {
        window.localStorage.setItem("sakamichi-bulk-job", JSON.stringify({ id: data.job.id, selection }));
        setSavedBulkJobId(data.job.id);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ブログの保存を開始できませんでした。");
    } finally { setSubmitting(false); }
  }

  async function resumeBulkJob() {
    if (!readyToken || !savedBulkJobId) return;
    try {
      const saved = JSON.parse(window.localStorage.getItem("sakamichi-bulk-job") ?? "null") as { id?: string; selection?: unknown } | null;
      if (!saved || saved.id !== savedBulkJobId || !/^[0-9a-f-]{36}$/.test(saved.id)) throw new Error("前回の保存情報を確認できませんでした。");
      const selection = validateSelection(saved.selection);
      if (selection.range !== "all") throw new Error("前回の保存情報を確認できませんでした。");
      const response = await fetch(`/api/jobs/${saved.id}`, { cache: "no-store", headers: { Authorization: `Bearer ${readyToken}` } });
      if (!response.ok) throw new Error("前回のジョブを読み込めませんでした。");
      const data = await response.json() as { job: LocalJob };
      if (data.job.kind !== "blog") throw new Error("前回の保存情報を確認できませんでした。");
      setBulkSelection(selection);
      setJob(data.job);
      setMessage("");
      setView("blog");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "前回のジョブを読み込めませんでした。");
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
        公式サイトの一覧からメンバーと取得範囲を選べます。写真の閲覧・保存と、ブログの複数件・全件バックアップができます。
      </p>
    </div>}
    <section ref={setupRef} className="workspace" aria-labelledby="workspace-title" hidden={view !== "setup"}>
      <div className="workspace-heading">
        <div><h2 ref={setupHeadingRef} id="workspace-title" tabIndex={-1}>取得条件を決める</h2></div>
        <span className="phase-badge">ローカル版</span>
      </div>
      <p className="workspace-description">メンバーを選んで、保存する内容とブログの範囲を決めます。</p>
      {job && <button type="button" className="secondary-button photo-reopen" onClick={() => setView(job.kind === "photos" ? "photos" : "blog")}>{job.kind === "photos" ? "写真の取得結果を見る" : "ブログの保存結果を見る"}</button>}
      {savedBulkJobId && readyToken && <button type="button" className="secondary-button photo-reopen" disabled={busy} onClick={() => void resumeBulkJob()}>前回の全件バックアップの結果を見る・再開する</button>}
      <div className="token-field">
        <label htmlFor="access-token">ローカルアクセストークン</label>
        <input id="access-token" type="password" autoComplete="off" value={accessToken} onChange={(event) => { setAccessToken(event.target.value); setReadyToken(""); }} aria-describedby="token-help" />
        <p id="token-help" className="field-help">開発PCの .env.local に設定したトークンを入力してください。</p>
      </div>

      {readyToken ? <AcquisitionPlanner token={readyToken} busy={busy} onSaveBlog={submitBlogJob} onSavePhotos={submitPhotoJob} />
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

    </section>
    <section ref={resultRef} className="workspace photo-result-screen" aria-labelledby="result-title" hidden={view === "setup"}>
      <div className="photo-screen-nav">
        <button type="button" className="secondary-button" onClick={() => setView("setup")}>条件設定に戻る</button>
        <span className="phase-badge">{view === "photos" ? "写真のみ" : "ブログ"}</span>
      </div>
      <h2 ref={resultHeadingRef} id="result-title" tabIndex={-1} aria-live="polite">{view === "photos" ? job?.kind === "photos" && job.status === "succeeded" ? "取得した写真" : "写真の取得結果" : "ブログの保存結果"}</h2>
      {submitting && <p className="photo-screen-message" role="status">{view === "photos" ? "写真の取得" : "ブログの保存"}を開始しています…</p>}
      {message && <p className="form-message" role="alert">{message}</p>}
      {view === "blog" && job?.kind === "blog" && <div className="job-result" aria-live="polite">
        <div className="job-result-top"><strong>{statusLabel[job.status]}</strong><span className={`status-dot status-${job.status}`} aria-hidden="true" /></div>
        {(job.status === "queued" || job.status === "running") && <p>保存済み {job.savedCount ?? 0} / {job.requestedArticles?.length ?? 1} 件。完了すると ZIP をダウンロードできます。</p>}
        {job.status === "succeeded" && <>
          <p>{job.savedCount ?? 1}件のブログを保存しました。</p>
          <a className="primary-button" href={`/api/blog-jobs/${job.id}/zip`}>PDF・MHTMLをZIPで保存</a>
          <p className="field-help">ZIP内はメンバー別・ブログ別フォルダです。各ブログに metadata.json を含みます。</p>
          <p className="field-help">PC上の保存先: <code>{job.outputDirectory}</code></p>
          {bulkSelection && job.nextCursor && <button type="button" className="secondary-button" disabled={busy} onClick={() => void submitBlogJob({ ...bulkSelection, cursor: job.nextCursor })}>次の10件を保存</button>}
          {bulkSelection && !job.nextCursor && <p className="field-help">公式一覧の最後まで保存しました。</p>}
        </>}
        {job.error && <p className="form-message">{job.error}</p>}
        {job.status === "failed" && bulkSelection && <button type="button" className="secondary-button" onClick={() => void submitBlogJob(bulkSelection)}>この10件を再試行</button>}
        {job.log.length > 0 && <details><summary>処理ログを確認</summary><pre>{job.log.join("\n")}</pre></details>}
      </div>}
      {view === "photos" && job?.kind === "photos" && job.status !== "succeeded" && <div className="job-result" aria-live="polite">
        <div className="job-result-top"><strong>{job.status === "running" ? "写真を取得中" : statusLabel[job.status]}</strong><span className={`status-dot status-${job.status}`} aria-hidden="true" /></div>
        {(job.status === "queued" || job.status === "running") && <p>写真を取得しています。完了するとこの画面に表示します。</p>}
        {job.error && <p className="form-message">{job.error}</p>}
      </div>}
      {view === "photos" && job?.kind === "photos" && job.photoArticles && <div ref={galleryRef} className="photo-gallery-anchor"><PhotoGallery job={job} /></div>}
      {job && (view === "blog" || job.photoArticles) && <button type="button" className="secondary-button photo-back-bottom" onClick={() => setView("setup")}>条件設定に戻る</button>}
    </section>
    </>
  );
}
