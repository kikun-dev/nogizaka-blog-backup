"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { BlogArticlePage, BlogAuthor, BlogGroup } from "@/lib/catalog/types";
import type { LocalJob } from "@/server/job-store";

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
  const [group, setGroup] = useState<BlogGroup>("nogizaka");
  const [authors, setAuthors] = useState<BlogAuthor[]>([]);
  const [authorId, setAuthorId] = useState("");
  const [articlePage, setArticlePage] = useState<BlogArticlePage | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [authorsLoading, setAuthorsLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [job, setJob] = useState<LocalJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const activeJobId = job?.id;
  const activeStatus = job?.status;

  useEffect(() => {
    if (!accessToken) return;
    const timer = window.setTimeout(() => setReadyToken(accessToken), 600);
    return () => window.clearTimeout(timer);
  }, [accessToken]);

  useEffect(() => {
    if (!readyToken) return;
    const controller = new AbortController();
    async function loadAuthors() {
      setAuthorsLoading(true);
      setCatalogMessage("");
      try {
        const response = await fetch(`/api/catalog/${group}/authors`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${readyToken}` },
          signal: controller.signal,
        });
        const data = await response.json() as { authors?: BlogAuthor[]; error?: string };
        if (!response.ok || !data.authors) throw new Error(data.error ?? "一覧を取得できませんでした。");
        if (!controller.signal.aborted) setAuthors(data.authors);
      } catch (error) {
        if (!controller.signal.aborted) setCatalogMessage(error instanceof Error ? error.message : "一覧を取得できませんでした。");
      } finally {
        if (!controller.signal.aborted) setAuthorsLoading(false);
      }
    }
    void loadAuthors();
    return () => controller.abort();
  }, [group, readyToken, retryCount]);

  useEffect(() => {
    if (!authorId) return;
    const controller = new AbortController();
    async function loadArticles() {
      setArticlesLoading(true);
      setCatalogMessage("");
      setArticlePage(null);
      try {
        const response = await fetch(`/api/catalog/${group}/authors/${authorId}/articles?page=${pageNumber}`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${readyToken}` },
          signal: controller.signal,
        });
        const data = await response.json() as { articles?: BlogArticlePage; error?: string };
        if (!response.ok || !data.articles) throw new Error(data.error ?? "記事一覧を取得できませんでした。");
        setArticlePage(data.articles);
      } catch (error) {
        if (controller.signal.aborted) return;
        setCatalogMessage(error instanceof Error ? error.message : "記事一覧を取得できませんでした。");
      } finally {
        if (!controller.signal.aborted) setArticlesLoading(false);
      }
    }
    void loadArticles();
    return () => controller.abort();
  }, [group, authorId, pageNumber, readyToken, retryCount]);

  function changeToken(value: string) {
    setAccessToken(value);
    setReadyToken("");
    setAuthorsLoading(false);
    setArticlesLoading(false);
    setAuthors([]);
    setAuthorId("");
    setArticlePage(null);
    setPageNumber(1);
    setCatalogMessage("");
  }

  function selectGroup(value: BlogGroup) {
    setGroup(value);
    setAuthorsLoading(false);
    setArticlesLoading(false);
    setAuthors([]);
    setAuthorId("");
    setArticlePage(null);
    setPageNumber(1);
    setUrl("");
    setCatalogMessage("");
  }

  function selectAuthor(value: string) {
    setAuthorId(value);
    setArticlePage(null);
    setPageNumber(1);
    setUrl("");
  }

  function selectPage(value: number) {
    setArticlePage(null);
    setPageNumber(value);
    setUrl("");
  }

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || job?.status === "running" || job?.status === "queued") return;
    setSubmitting(true);
    setMessage("");
    setJob(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
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
        公式ブログから記事を選び、PDFとMHTMLをこのパソコンの開発用フォルダへ保存します。
      </p>
      <form onSubmit={submit} className="job-form">
        <label htmlFor="access-token">ローカルアクセストークン</label>
        <input
          id="access-token"
          type="password"
          autoComplete="off"
          required
          value={accessToken}
          onChange={(event) => changeToken(event.target.value)}
          aria-describedby="token-help"
        />
        <p id="token-help" className="field-help">開発 PC の .env.local に設定したトークンを入力してください。</p>
        <div className="catalog-picker">
          <h3>公式サイトから選ぶ</h3>
          <div className="catalog-source-row">
            <div>
              <label htmlFor="blog-group">グループ</label>
              <select id="blog-group" value={group} onChange={(event) => selectGroup(event.target.value as BlogGroup)}>
                <option value="nogizaka">乃木坂46</option>
                <option value="sakurazaka">櫻坂46</option>
                <option value="hinatazaka">日向坂46</option>
              </select>
            </div>
          </div>
          {!readyToken && <p className="field-help">トークンを入力するとメンバー一覧を読み込みます。</p>}
          {authorsLoading && <p className="field-help" role="status">メンバー一覧を読み込んでいます…</p>}
          {authors.length > 0 && (
            <div className="catalog-author-field">
              <label htmlFor="blog-author">メンバー</label>
              <select id="blog-author" value={authorId} onChange={(event) => selectAuthor(event.target.value)}>
                <option value="">選択してください</option>
                {authors.map((author) => <option key={author.id} value={author.id}>{author.name}{author.type !== "member" ? `（${{
                  generation: "期別", staff: "運営", mascot: "マスコット", other: "その他",
                }[author.type]}）` : ""}</option>)}
              </select>
            </div>
          )}
          {catalogMessage && <div className="catalog-error" role="alert"><p className="form-message">{catalogMessage}</p><button type="button" className="secondary-button" onClick={() => setRetryCount((count) => count + 1)}>再試行</button></div>}
          {articlesLoading && authorId && <p className="field-help" role="status">記事一覧を読み込んでいます…</p>}
          {articlePage && (
            <div className="catalog-articles">
              <div className="catalog-articles-heading">
                <h4>{authors.find((author) => author.id === authorId)?.name}の記事</h4>
                <span>{articlePage.page}ページ目</span>
              </div>
              {articlePage.items.length === 0 ? (
                <p className="field-help">このページに記事がありません。公式サイトでも一覧を確認できない場合があります。</p>
              ) : (
                <ul className="catalog-article-list">
                  {articlePage.items.map((article) => <li key={article.id}>
                    <div><strong>{article.title}</strong>{article.excerpt && <span className="catalog-excerpt">{article.excerpt}</span>}<time>{article.date || "日付なし"}</time></div>
                    <button type="button" className="article-select" onClick={() => setUrl(article.url)} aria-label={`${article.title}を保存対象に選ぶ`}>
                      {url === article.url ? "選択中" : "選ぶ"}
                    </button>
                  </li>)}
                </ul>
              )}
              <div className="catalog-pagination">
                <button type="button" className="secondary-button" disabled={pageNumber === 1 || articlesLoading} onClick={() => selectPage(pageNumber - 1)}>前のページ</button>
                <button type="button" className="secondary-button" disabled={!articlePage.hasNext || articlesLoading} onClick={() => selectPage(pageNumber + 1)}>次のページ</button>
              </div>
            </div>
          )}
        </div>
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
        <p id="url-help" className="field-help">記事を選ぶとURLが入ります。公式一覧にない記事はURLを直接入力できます。</p>
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
