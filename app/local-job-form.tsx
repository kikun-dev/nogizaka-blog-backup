"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { LocalJob } from "@/server/job-store";

const statusLabel = {
  queued: "開始待ち",
  running: "保存中",
  succeeded: "保存しました",
  failed: "保存できませんでした",
} as const;

export function LocalJobForm() {
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<LocalJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const activeJobId = job?.id;
  const activeStatus = job?.status;

  useEffect(() => {
    if (!activeJobId || (activeStatus !== "queued" && activeStatus !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${activeJobId}`, { cache: "no-store" });
        if (!response.ok) throw new Error("状態を確認できませんでした。画面を再読み込みしてください。");
        const data = await response.json() as { job: LocalJob };
        setJob(data.job);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "状態を確認できませんでした。");
        window.clearInterval(timer);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeJobId, activeStatus]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || job?.status === "running" || job?.status === "queued") return;
    setSubmitting(true);
    setMessage("");
    setJob(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
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

  const busy = submitting || job?.status === "queued" || job?.status === "running";

  return (
    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div>
          <span className="workspace-label">ローカル動作確認</span>
          <h2 id="workspace-title">記事を1件保存する</h2>
        </div>
        <span className="phase-badge">準備段階</span>
      </div>
      <p className="workspace-description">
        公式ブログの記事URLを入力してください。PDFとMHTMLをこのパソコンの開発用フォルダへ保存します。
      </p>
      <form onSubmit={submit} className="job-form">
        <label htmlFor="article-url">個別記事のURL</label>
        <div className="input-row">
          <input
            id="article-url"
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.nogizaka46.com/s/n46/diary/detail/..."
            aria-describedby="url-help"
          />
          <button type="submit" disabled={busy}>{submitting ? "開始中…" : "保存を開始"}</button>
        </div>
        <p id="url-help" className="field-help">乃木坂46・櫻坂46・日向坂46の個別記事URLに対応しています。</p>
      </form>

      {message && <p className="form-message" role="alert">{message}</p>}
      {job && (
        <div className="job-result" aria-live="polite">
          <div className="job-result-top">
            <strong>{statusLabel[job.status]}</strong>
            <span className={`status-dot status-${job.status}`} aria-hidden="true" />
          </div>
          {job.status === "succeeded" && (
            <p>保存先: <code>{job.outputDirectory}</code></p>
          )}
          {job.error && <p className="form-message">{job.error}</p>}
          {job.log.length > 0 && (
            <details>
              <summary>処理ログを確認</summary>
              <pre>{job.log.join("\n")}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
