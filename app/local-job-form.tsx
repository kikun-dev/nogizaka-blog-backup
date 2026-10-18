"use client";

import { useEffect, useState, type FormEvent } from "react";
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
  const [url, setUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [readyToken, setReadyToken] = useState("");
  const [job, setJob] = useState<LocalJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const activeJobId = job?.id;
  const activeStatus = job?.status;
  const busy = submitting || activeStatus === "queued" || activeStatus === "running";

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
    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div><h2 id="workspace-title">取得条件を決める</h2></div>
        <span className="phase-badge">ローカル版</span>
      </div>
      <p className="workspace-description">メンバーを選んで、保存する内容とブログの範囲を決めます。</p>
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

      {message && <p className="form-message" role="alert">{message}</p>}
      {job && (
        <div className="job-result" aria-live="polite">
          <div className="job-result-top"><strong>{job.kind === "photos" && job.status === "succeeded" ? "写真を取得しました" : statusLabel[job.status]}</strong><span className={`status-dot status-${job.status}`} aria-hidden="true" /></div>
          {job.status === "succeeded" && job.kind !== "photos" && <p>保存先: <code>{job.outputDirectory}</code></p>}
          {job.kind === "photos" && (job.status === "queued" || job.status === "running") && <p>写真を取得しています。完了するとここに表示します。</p>}
          {job.error && <p className="form-message">{job.error}</p>}
          {job.log.length > 0 && <details><summary>処理ログを確認</summary><pre>{job.log.join("\n")}</pre></details>}
        </div>
      )}
      {job?.kind === "photos" && job.photoArticles && <PhotoGallery job={job} />}
    </section>
  );
}
