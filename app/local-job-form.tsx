"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LocalJob } from "@/server/job-store";
import type { SelectionSubmission } from "@/lib/selection";
import { emptyPreferences, favoriteKey, parsePreferences, PREFERENCES_KEY, serializePreferences, type FavoriteAuthor, type LocalPreferences } from "@/lib/local-preferences";
import { canShowPhotoGallery } from "@/lib/photo-gallery-visibility";
import { clearRecentPublicJob, restoreRecentPublicJob, saveRecentPublicJob } from "@/lib/recent-public-job";
import { AcquisitionPlanner } from "./acquisition-planner";
import { PhotoGallery } from "./photo-gallery";
import { RemoveSavedItemButton } from "./remove-saved-item-button";

const statusLabel = {
  queued: "開始待ち",
  running: "保存中",
  succeeded: "保存しました",
  partial: "一部を保存しました",
  failed: "保存できませんでした",
} as const;
const groupName = { nogizaka: "乃木坂46", sakurazaka: "櫻坂46", hinatazaka: "日向坂46" } as const;

export function LocalJobForm({ publicMode = false }: { publicMode?: boolean }) {
  const [view, setView] = useState<"setup" | "photos" | "blog">("setup");
  const [url, setUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [readyToken, setReadyToken] = useState("");
  const [preferencesPreview, setPreferencesPreview] = useState<LocalPreferences>(emptyPreferences);
  const [pendingFavorite, setPendingFavorite] = useState<FavoriteAuthor | null>(null);
  const [job, setJob] = useState<LocalJob | null>(null);
  const [savedBulkJobId, setSavedBulkJobId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [workerOffline, setWorkerOffline] = useState(false);
  const previousView = useRef(view);
  const setupRef = useRef<HTMLElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousPhotoStatus = useRef<LocalJob["status"] | undefined>(undefined);
  const submittingRef = useRef(false);
  const sessionCheckVersion = useRef(0);
  const activeJobId = job?.id;
  const activeStatus = job?.status;
  const busy = submitting || activeStatus === "queued" || activeStatus === "running";
  const photoGalleryReady = canShowPhotoGallery(job, publicMode);

  function updatePreferencesPreview(next: LocalPreferences) {
    setPreferencesPreview(next);
    try {
      if (next.favorites.length) window.localStorage.setItem(PREFERENCES_KEY, serializePreferences(next));
      else window.localStorage.removeItem(PREFERENCES_KEY);
    } catch { /* Storage may be disabled. */ }
  }

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
    if (readyToken) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        const raw = window.localStorage.getItem(PREFERENCES_KEY);
        const saved = parsePreferences(raw);
        setPreferencesPreview(saved);
        if (raw && (saved.favorites.length === 0 || raw !== serializePreferences(saved))) {
          if (saved.favorites.length) window.localStorage.setItem(PREFERENCES_KEY, serializePreferences(saved));
          else window.localStorage.removeItem(PREFERENCES_KEY);
        }
      }
      catch { setPreferencesPreview(emptyPreferences()); }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [readyToken]);

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const section = view === "photos"
      ? photoGalleryReady ? galleryRef.current : resultRef.current
      : setupRef.current;
    const target = view === "blog" ? resultRef.current : section;
    const heading = view === "setup" ? setupHeadingRef.current : resultHeadingRef.current;
    const frame = window.requestAnimationFrame(() => target?.scrollIntoView({ block: "start", behavior: "auto" }));
    heading?.focus({ preventScroll: true });
    return () => window.cancelAnimationFrame(frame);
  }, [view, photoGalleryReady]);

  useEffect(() => {
    const status = job?.kind === "photos" ? job.status : undefined;
    let frame: number | undefined;
    if (view === "photos" && photoGalleryReady
      && (status === "succeeded" || status === "partial" || status === "failed") && previousPhotoStatus.current !== status) {
      frame = window.requestAnimationFrame(() => galleryRef.current?.scrollIntoView({ block: "start", behavior: "auto" }));
    }
    previousPhotoStatus.current = status;
    return () => { if (frame !== undefined) window.cancelAnimationFrame(frame); };
  }, [job, view, photoGalleryReady]);

  useEffect(() => {
    if (!publicMode) return;
    let active = true;
    const version = ++sessionCheckVersion.current;
    void (async () => {
      const restored = await restoreRecentPublicJob(window.localStorage, fetch);
      if (!active || version !== sessionCheckVersion.current) return;
      if (restored.authenticated) setReadyToken("public-session");
      if (restored.job) {
        setJob(restored.job);
        setWorkerOffline(restored.workerOffline);
        setView(restored.job.kind === "photos" ? "photos" : "blog");
      }
    })().catch((error: unknown) => {
      if (active && version === sessionCheckVersion.current) {
        setMessage(error instanceof Error ? error.message : "アクセス状態を確認できませんでした。");
      }
    });
    return () => { active = false; };
  }, [publicMode]);

  useEffect(() => {
    if (publicMode && job?.id) saveRecentPublicJob(window.localStorage, job.id);
  }, [publicMode, job?.id]);

  useEffect(() => {
    if (publicMode) return;
    if (!accessToken) return;
    const timer = window.setTimeout(() => setReadyToken(accessToken), 600);
    return () => window.clearTimeout(timer);
  }, [accessToken, publicMode]);

  async function loginPublic() {
    sessionCheckVersion.current++;
    setMessage("");
    try {
      const response = await fetch("/api/access-session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: accessToken }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "アクセスできませんでした。");
      clearRecentPublicJob(window.localStorage);
      setJob(null);
      setAccessToken("");
      setReadyToken("public-session");
    } catch (error) { setMessage(error instanceof Error ? error.message : "アクセスできませんでした。"); }
  }

  useEffect(() => {
    if (!activeJobId || (activeStatus !== "queued" && activeStatus !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${activeJobId}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          if (publicMode && response.status === 401) {
            clearRecentPublicJob(window.localStorage);
            setReadyToken("");
            setJob(null);
            setView("setup");
          }
          const failure = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(failure.error ?? "状態を確認できませんでした。画面を再読み込みしてください。");
        }
        const data = await response.json() as { job: LocalJob; workerOffline?: boolean };
        setJob(data.job);
        setWorkerOffline(Boolean(data.workerOffline));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "状態を確認できませんでした。");
        window.clearInterval(timer);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [activeJobId, activeStatus, accessToken, publicMode]);

  async function submitJob(articleUrl: string) {
    if (busy || submittingRef.current) return;
    if (!accessToken) {
      setMessage("ローカルアクセストークンを入力してください。");
      return;
    }
    setUrl(articleUrl);
    submittingRef.current = true;
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
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function submitBlogJob(selection: SelectionSubmission) {
    if (busy || submittingRef.current) return;
    submittingRef.current = true;
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
        window.localStorage.setItem("sakamichi-bulk-job", JSON.stringify({ id: data.job.id }));
        setSavedBulkJobId(data.job.id);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ブログの保存を開始できませんでした。");
    } finally { submittingRef.current = false; setSubmitting(false); }
  }

  async function resumeBulkJob() {
    if (!readyToken || !savedBulkJobId) return;
    try {
      const saved = JSON.parse(window.localStorage.getItem("sakamichi-bulk-job") ?? "null") as { id?: string } | null;
      if (!saved || saved.id !== savedBulkJobId || !/^[0-9a-f-]{36}$/.test(saved.id)) throw new Error("前回の保存情報を確認できませんでした。");
      const response = await fetch(`/api/jobs/${saved.id}`, { cache: "no-store", headers: { Authorization: `Bearer ${readyToken}` } });
      if (!response.ok) throw new Error("前回のジョブを読み込めませんでした。");
      const data = await response.json() as { job: LocalJob };
      if (!data.job.fullBackup) throw new Error("前回の保存情報を確認できませんでした。");
      setJob(data.job);
      setMessage("");
      setView("blog");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "前回のジョブを読み込めませんでした。");
    }
  }

  async function resumeFailedBackup() {
    if (!job?.fullBackup || job.status !== "failed" || busy) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`/api/blog-jobs/${job.id}/resume`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error ?? "再開できませんでした。");
      setJob(data.job);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "再開できませんでした。");
    } finally { setSubmitting(false); }
  }

  async function continueBackup() {
    if (!job?.fullBackup || job.status !== "succeeded" || !job.backupStopReason || busy) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`/api/blog-jobs/${job.id}/continue`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error ?? "続きから開始できませんでした。");
      window.localStorage.setItem("sakamichi-bulk-job", JSON.stringify({ id: data.job.id }));
      setSavedBulkJobId(data.job.id);
      setJob(data.job);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "続きから開始できませんでした。");
    } finally { setSubmitting(false); }
  }

  async function submitPhotoJob(selection: SelectionSubmission) {
    if (busy || submittingRef.current) return;
    submittingRef.current = true;
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
    } finally { submittingRef.current = false; setSubmitting(false); }
  }

  async function retryFailedArticles() {
    if (!job || busy || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`/api/jobs/${job.id}/retry`, {
        method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json() as { job?: LocalJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error ?? "再試行を開始できませんでした。");
      setJob(data.job);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "再試行を開始できませんでした。");
    } finally { submittingRef.current = false; setSubmitting(false); }
  }

  async function showOriginalJob() {
    if (!job?.retryOfJobId) return;
    try {
      const response = await fetch(`/api/jobs/${job.retryOfJobId}`, {
        cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json() as { job?: LocalJob };
      if (!response.ok || !data.job) throw new Error("元の結果を読み込めませんでした。");
      setJob(data.job);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "元の結果を読み込めませんでした。");
    }
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
        公式サイトの一覧からメンバーと取得範囲を選べます。写真の閲覧・保存と、ブログの複数件{publicMode ? "" : "・全件バックアップ"}ができます。
      </p>
    </div>}
    <section ref={setupRef} className="workspace" aria-labelledby="workspace-title" hidden={view !== "setup"}>
      <div className="workspace-heading">
        <div><h2 ref={setupHeadingRef} id="workspace-title" tabIndex={-1}>取得条件を決める</h2></div>
        <span className="phase-badge">{publicMode ? "公開版" : "ローカル版"}</span>
      </div>
      <p className="workspace-description">メンバーを選んで、保存する内容とブログの範囲を決めます。</p>
      {job && <button type="button" className="secondary-button photo-reopen" onClick={() => setView(job.kind === "photos" ? "photos" : "blog")}>{job.kind === "photos" ? "写真の取得結果を見る" : "ブログの保存結果を見る"}</button>}
      {!publicMode && savedBulkJobId && readyToken && <button type="button" className="secondary-button photo-reopen" disabled={busy} onClick={() => void resumeBulkJob()}>前回の全件バックアップの結果を見る・再開する</button>}
      {publicMode && readyToken ? <p className="field-help" role="status">アクセスを確認しました。保存後は早めにダウンロードしてください。アプリでの期限は保存完了から24時間です。</p> : <div className="token-field">
        <label htmlFor="access-token">{publicMode ? "共有アクセスコード" : "ローカルアクセストークン"}</label>
        <input ref={tokenRef} id="access-token" type="password" autoComplete="off" value={accessToken} onChange={(event) => { if (readyToken) setPendingFavorite(null); setAccessToken(event.target.value); setReadyToken(""); }} aria-describedby="token-help" />
        <p id="token-help" className="field-help">{publicMode ? "共有されたアクセスコードを入力してください。" : "開発PCの .env.local に設定したトークンを入力してください。"}</p>
        {publicMode && !readyToken && <button type="button" className="secondary-button" onClick={() => void loginPublic()}>アクセスする</button>}
      </div>}
      {message && view === "setup" && <p className="form-message" role="alert">{message}</p>}

      {readyToken ? <AcquisitionPlanner token={readyToken} publicMode={publicMode} busy={busy} initialFavorite={pendingFavorite} onSaveBlog={submitBlogJob} onSavePhotos={submitPhotoJob} />
        : <>
          {preferencesPreview.favorites.length > 0 && <div className="saved-preferences landing-favorites">
            <h3>お気に入りのブログ</h3>
            <ul>{preferencesPreview.favorites.map((favorite) => <li key={favoriteKey(favorite)}>
              <button type="button" className="favorite-shortcut" onClick={() => { setPendingFavorite(favorite); tokenRef.current?.focus(); }}><strong>{favorite.authorName}</strong><small>{groupName[favorite.group]}</small></button>
              <RemoveSavedItemButton label={`${favorite.authorName}をお気に入りから外す`} onClick={() => {
                updatePreferencesPreview({ ...preferencesPreview, favorites: preferencesPreview.favorites.filter((entry) => favoriteKey(entry) !== favoriteKey(favorite)) });
                if (pendingFavorite && favoriteKey(pendingFavorite) === favoriteKey(favorite)) setPendingFavorite(null);
              }} />
            </li>)}</ul>
            {pendingFavorite && <p className="field-help" role="status">{pendingFavorite.authorName}を選択しました。トークンを入力すると取得条件に反映します。</p>}
            <p className="field-help">このブラウザーに保存されています。共用端末ではお気に入りを外してください。</p>
          </div>}
          <p className="selection-start-help">{publicMode ? "アクセスコードを入力すると取得条件を選べます。" : "トークンを入力すると取得条件を選べます。"}</p>
        </>}

      {!publicMode && <form onSubmit={submit} className="job-form direct-url-form">
        <h3>ブログの個別URLで1件保存</h3>
        <p className="field-help">公式一覧にないブログはURLを直接入力できます。PDFとMHTMLを保存します。</p>
        <label htmlFor="article-url">ブログの個別URL</label>
        <div className="input-row">
          <input id="article-url" type="url" inputMode="url" autoComplete="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.nogizaka46.com/s/n46/diary/detail/..." />
          <button type="submit" disabled={busy}>{submitting ? "開始中…" : "保存を開始"}</button>
        </div>
      </form>}

    </section>
    <section ref={resultRef} className="workspace photo-result-screen" aria-labelledby="result-title" hidden={view === "setup"}>
      <div className="photo-screen-nav">
        <button type="button" className="secondary-button" onClick={() => setView("setup")}>条件設定に戻る</button>
        <span className="phase-badge">{view === "photos" ? "写真のみ" : "ブログ"}</span>
      </div>
      <h2 ref={resultHeadingRef} id="result-title" tabIndex={-1} aria-live="polite">{view === "photos" ? job?.kind === "photos" && (job.status === "succeeded" || job.status === "partial") ? "取得した写真" : "写真の取得結果" : "ブログの保存結果"}</h2>
      {submitting && <p className="photo-screen-message" role="status">{view === "photos" ? "写真の取得" : "ブログの保存"}を開始しています…</p>}
      {message && <p className="form-message" role="alert">{message}</p>}
      {publicMode && workerOffline && job?.status === "queued" && <p className="form-message" role="status">ワーカーが停止中です。開始までお待ちください。</p>}
      {job && !job.fullBackup && <div className="job-progress" aria-live="polite">
        <p>進捗: {job.articleResults?.length ?? 0} / {job.requestedArticles?.length ?? 1} 件</p>
        {job.currentArticle && <p>処理中: {job.currentArticle.title}（{job.currentArticle.date || "投稿日不明"}）</p>}
        <p>成功 {job.articleResults?.filter((article) => article.status === "succeeded").length ?? 0} 件 / 失敗 {job.articleResults?.filter((article) => article.status === "failed").length ?? 0} 件</p>
        {!!job.retryOfJobId && <p>失敗した記事の再試行結果です。元のジョブで保存した記事は再取得していません。 <button type="button" className="secondary-button" onClick={() => void showOriginalJob()}>元の結果を見る</button></p>}
        {!!job.articleResults?.some((article) => article.status === "failed") && <>
          <ul>{job.articleResults.filter((article) => article.status === "failed").map((article) => <li key={article.id}>{article.title}（{article.date || "投稿日不明"}）: {article.message}</li>)}</ul>
          {(job.status === "partial" || job.status === "failed") && <button type="button" className="secondary-button" disabled={busy} onClick={() => void retryFailedArticles()}>失敗した記事だけ再試行</button>}
        </>}
      </div>}
      {view === "blog" && job?.kind === "blog" && <div className="job-result" aria-live="polite">
        <div className="job-result-top"><strong>{statusLabel[job.status]}</strong><span className={`status-dot status-${job.status}`} aria-hidden="true" /></div>
        {job.fullBackup && !!job.priorPartIds?.length && <div className="backup-parts">
          <p>前のパートのZIP</p>
          <ol>{job.priorPartIds.map((id, index) => <li key={id}><a href={`/api/blog-jobs/${id}/zip`}>パート{index + 1}を保存</a></li>)}</ol>
        </div>}
        {(job.status === "queued" || job.status === "running") && <p>{job.fullBackup
          ? job.backupPhase === "packaging" ? `保存済み${job.savedCount ?? 0}件。1つのZIPを作成中です。` : `保存済み${job.savedCount ?? 0}件。公式一覧の最後まで自動で取得します。`
          : `保存済み ${job.savedCount ?? 0} / ${job.requestedArticles?.length ?? 1} 件。完了すると ZIP をダウンロードできます。`}</p>}
        {job.fullBackup && job.currentArticle && <p>処理中: {job.currentArticle.title}（{job.currentArticle.date || "投稿日不明"}）</p>}
        {(job.status === "succeeded" || job.status === "partial") && <>
          <p>{job.savedCount ?? 1}件のブログを保存しました。</p>
          {job.blogZipReady && <a className="primary-button" href={`/api/blog-jobs/${job.id}/zip`}>{job.fullBackup && job.backupStopReason ? `今回の${job.savedCount ?? 0}件をZIPで保存` : "PDF・MHTMLをZIPで保存"}</a>}
          {job.fullBackup &&
            <p className="field-help">4 GB以上のZIPはWindows標準の「すべて展開」でエラーになる場合があります。ダウンロード後は7-ZipなどZIP64対応アプリで展開してください。</p>}
          <p className="field-help">ZIP内はメンバー別・ブログ別フォルダです。各ブログに metadata.json を含みます。</p>
          {!publicMode && <p className="field-help">PC上の保存先: <code>{job.outputDirectory}</code></p>}
          {job.fullBackup && job.backupStopReason && job.nextCursor && <>
            <p className="field-help">{job.backupStopReason === "article-limit" ? "5,000件" : "保存データ19 GB"}の上限に達しました。保存済み分はZIPにまとめました。続きは公式一覧の{job.nextCursor.page}ページ目・{job.nextCursor.offset + 1}件目から開始します。</p>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void continueBackup()}>続きから全件バックアップを開始</button>
          </>}
          {job.fullBackup && !job.backupStopReason && <p className="field-help">公式一覧の最後まで保存しました。</p>}
        </>}
        {job.status === "failed" && job.error && <p className="form-message">{job.error}</p>}
        {job.status === "failed" && job.fullBackup && <button type="button" className="secondary-button" disabled={busy} onClick={() => void resumeFailedBackup()}>このバックアップを再開</button>}
        {job.log.length > 0 && <details><summary>処理ログを確認</summary><pre>{job.log.join("\n")}</pre></details>}
      </div>}
      {view === "photos" && job?.kind === "photos" && job.status !== "succeeded" && <div className="job-result" aria-live="polite">
        <div className="job-result-top"><strong>{job.status === "running" ? "写真を取得中" : statusLabel[job.status]}</strong><span className={`status-dot status-${job.status}`} aria-hidden="true" /></div>
        {(job.status === "queued" || job.status === "running") && <p>写真を取得しています。完了するとこの画面に表示します。</p>}
        {job.error && <p className="form-message">{job.error}</p>}
      </div>}
      {view === "photos" && photoGalleryReady && job && <div ref={galleryRef} className="photo-gallery-anchor"><PhotoGallery job={job} /></div>}
      {job && (view === "blog" || photoGalleryReady) && <button type="button" className="secondary-button photo-back-bottom" onClick={() => setView("setup")}>条件設定に戻る</button>}
    </section>
    </>
  );
}
