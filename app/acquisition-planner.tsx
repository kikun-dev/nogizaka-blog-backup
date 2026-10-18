"use client";

import { useEffect, useState } from "react";
import type { BlogArticle, BlogArticlePage, BlogAuthor, BlogGroup } from "@/lib/catalog/types";
import { SELECTION_LIMITS, type SelectionContent, type SelectionPlan, type SelectionRange, type SelectionRequest } from "@/lib/selection";

type Stage = "conditions" | "articles" | "bulk";

const contentName = { photos: "写真のみ", blog: "ブログ" } as const;
const rangeName = {
  "latest-one": "最新1件",
  "latest-n": "最新N件",
  selected: "選んだ記事",
  all: "全件バックアップ",
} as const;

export function AcquisitionPlanner({ token, busy, onSaveBlog }: {
  token: string;
  busy: boolean;
  onSaveBlog: (url: string) => Promise<void>;
}) {
  const [group, setGroup] = useState<BlogGroup>("nogizaka");
  const [authors, setAuthors] = useState<BlogAuthor[]>([]);
  const [authorId, setAuthorId] = useState("");
  const [content, setContent] = useState<SelectionContent>("photos");
  const [range, setRange] = useState<SelectionRange>("latest-one");
  const [count, setCount] = useState("5");
  const [stage, setStage] = useState<Stage>("conditions");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSources, setPageSources] = useState<number[]>([1]);
  const [articlePage, setArticlePage] = useState<BlogArticlePage | null>(null);
  const [selected, setSelected] = useState<Record<string, BlogArticle>>({});
  const [plan, setPlan] = useState<SelectionPlan | null>(null);
  const [loadingAuthors, setLoadingAuthors] = useState(false);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const limit = SELECTION_LIMITS[content];
  const selectedCount = Object.keys(selected).length;
  const memberAuthors = authors.filter((author) => author.type === "member");
  const otherAuthors = authors.filter((author) => author.type !== "member");
  const sourcePage = pageSources[pageNumber - 1];

  useEffect(() => {
    const controller = new AbortController();
    async function loadAuthors() {
      setLoadingAuthors(true);
      setMessage("");
      try {
        const response = await fetch(`/api/catalog/${group}/authors`, {
          cache: "no-store",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const data = await response.json() as { authors?: BlogAuthor[]; error?: string };
        if (!response.ok || !data.authors) throw new Error(data.error ?? "メンバー一覧を取得できませんでした。");
        if (!controller.signal.aborted) setAuthors(data.authors);
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "メンバー一覧を取得できませんでした。");
      } finally {
        if (!controller.signal.aborted) setLoadingAuthors(false);
      }
    }
    void loadAuthors();
    return () => controller.abort();
  }, [group, token, retry]);

  useEffect(() => {
    if (stage !== "articles" || !authorId || !sourcePage) return;
    const controller = new AbortController();
    async function loadArticles() {
      setLoadingArticles(true);
      setMessage("");
      try {
        async function fetchSourcePage(number: number) {
          const response = await fetch(`/api/catalog/${group}/authors/${authorId}/articles?page=${number}`, {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          const data = await response.json() as { articles?: BlogArticlePage; error?: string };
          if (!response.ok || !data.articles) throw new Error(data.error ?? "記事一覧を取得できませんでした。");
          return data.articles;
        }
        const first = await fetchSourcePage(sourcePage);
        const second = content === "photos" && first.hasNext && first.items.length < 15
          ? await fetchSourcePage(sourcePage + 1)
          : null;
        if (!controller.signal.aborted) {
          setArticlePage({ items: second ? [...first.items, ...second.items] : first.items, page: pageNumber, hasNext: second?.hasNext ?? first.hasNext });
          setPageSources((current) => {
            const next = current.slice(0, pageNumber);
            next[pageNumber] = sourcePage + (second ? 2 : 1);
            return next;
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "記事一覧を取得できませんでした。");
      } finally {
        if (!controller.signal.aborted) setLoadingArticles(false);
      }
    }
    void loadArticles();
    return () => controller.abort();
  }, [stage, group, authorId, pageNumber, sourcePage, content, token, retry]);

  function changeGroup(value: BlogGroup) {
    setGroup(value);
    setAuthors([]);
    setAuthorId("");
    setSelected({});
    setArticlePage(null);
    setPageNumber(1);
    setPageSources([1]);
    setPlan(null);
    setMessage("");
    setStage("conditions");
  }

  function changeAuthor(value: string) {
    setAuthorId(value);
    setSelected({});
    setArticlePage(null);
    setPageNumber(1);
    setPageSources([1]);
    setPlan(null);
    setMessage("");
  }

  function changeContent(value: SelectionContent) {
    setContent(value);
    setSelected({});
    setArticlePage(null);
    setPageNumber(1);
    setPageSources([1]);
    setPlan(null);
    setMessage("");
  }

  function changeRange(value: SelectionRange) {
    setRange(value);
    setPlan(null);
    setMessage("");
  }

  function changePage(value: number) {
    setPageNumber(value);
    setArticlePage(null);
    setMessage("");
  }

  function toggleArticle(article: BlogArticle) {
    setPlan(null);
    if (!selected[article.id] && selectedCount >= limit) {
      setMessage(`${contentName[content]}は最大${limit}記事までです。ほかの記事を選ぶには、先に選択を解除してください。`);
      return;
    }
    setMessage("");
    setSelected((current) => {
      if (current[article.id]) {
        const next = { ...current };
        delete next[article.id];
        return next;
      }
      return { ...current, [article.id]: article };
    });
  }

  function togglePage() {
    if (!articlePage) return;
    const allSelected = articlePage.items.length > 0 && articlePage.items.every((article) => selected[article.id]);
    if (allSelected) {
      setSelected((current) => {
        const next = { ...current };
        for (const article of articlePage.items) delete next[article.id];
        return next;
      });
      setMessage("");
      setPlan(null);
      return;
    }
    const toAdd = articlePage.items.filter((article) => !selected[article.id]);
    if (selectedCount + toAdd.length > limit) {
      setMessage(`残り${limit - selectedCount}記事まで選べます。このページを一括選択するには、先に選択を減らしてください。`);
      return;
    }
    setSelected((current) => Object.fromEntries([
      ...Object.entries(current),
      ...toAdd.map((article) => [article.id, article] as const),
    ]));
    setPlan(null);
    setMessage("");
  }

  async function confirm() {
    if (!authorId || confirming) return;
    const request: SelectionRequest = { group, authorId, content, range };
    if (range === "latest-n") request.count = Number(count);
    if (range === "selected") request.urls = Object.values(selected).map((article) => article.url);
    setConfirming(true);
    setPlan(null);
    setMessage("");
    try {
      const response = await fetch("/api/selections", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
      });
      const data = await response.json() as { plan?: SelectionPlan; error?: string };
      if (!response.ok || !data.plan) throw new Error(data.error ?? "取得条件を確認できませんでした。");
      setPlan(data.plan);
      setStage("conditions");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "取得条件を確認できませんでした。");
    } finally {
      setConfirming(false);
    }
  }

  const selectedOnPage = articlePage?.items.length ? articlePage.items.every((article) => selected[article.id]) : false;
  const singleBlogUrl = plan?.content === "blog"
    ? plan.range === "latest-one" ? plan.firstArticle?.url
      : plan.range === "selected" && plan.urls?.length === 1 ? plan.urls[0] : undefined
    : undefined;

  return (
    <section className="selection-flow" aria-labelledby="selection-heading">
      <h3 id="selection-heading">公式サイトから条件を選ぶ</h3>
      {stage === "articles" ? (
        <div className="article-screen">
          <button type="button" className="text-button" onClick={() => { setStage("conditions"); setMessage(""); }}>条件の設定に戻る</button>
          <h4>{authors.find((author) => author.id === authorId)?.name}の記事を選ぶ</h4>
          <p className="field-help">新しい順に表示します。ページを移動しても選択は残ります。</p>
          {loadingArticles && <p role="status" className="field-help">記事を読み込んでいます…</p>}
          {articlePage && (
            <>
              <div className="article-page-heading">
                <span>{articlePage.page}ページ目・{articlePage.items.length}件</span>
                <button type="button" className="text-button" onClick={togglePage} disabled={articlePage.items.length === 0}>
                  {selectedOnPage ? "このページの選択を解除" : "このページをすべて選択"}
                </button>
              </div>
              {articlePage.items.length === 0 ? <p className="field-help">このページに記事はありません。</p> : (
                <ul className="selection-article-list">
                  {articlePage.items.map((article) => <li key={article.id}>
                    <label className="selection-article-row">
                      <input type="checkbox" checked={Boolean(selected[article.id])} onChange={() => toggleArticle(article)} disabled={!selected[article.id] && selectedCount >= limit} />
                      <span><strong>{article.title}</strong>{article.excerpt && <small>{article.excerpt}</small>}<time>{article.date || "日付なし"}</time></span>
                    </label>
                  </li>)}
                </ul>
              )}
              <div className="catalog-pagination">
                <button type="button" className="secondary-button" disabled={pageNumber === 1 || loadingArticles} onClick={() => changePage(pageNumber - 1)}>前のページ</button>
                <button type="button" className="secondary-button" disabled={!articlePage.hasNext || loadingArticles} onClick={() => changePage(pageNumber + 1)}>次のページ</button>
              </div>
            </>
          )}
          {message && <div role="alert"><p className="form-message">{message}</p>{!articlePage && <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>記事一覧を再読み込み</button>}</div>}
          {selectedCount >= limit && <p className="selection-limit-note" role="status">{contentName[content]}の上限は{limit}記事です。別の記事を選ぶには、選択を解除してください。</p>}
          <div className="selection-sticky-bar" aria-live="polite">
            <span><strong>{selectedCount}</strong> / {limit}記事を選択中</span>
            <button type="button" className="primary-button" disabled={selectedCount === 0 || confirming} onClick={() => void confirm()}>{confirming ? "確認中…" : "選択を確定"}</button>
          </div>
        </div>
      ) : stage === "bulk" ? (
        <div className="bulk-screen">
          <button type="button" className="text-button" onClick={() => { setStage("conditions"); changeRange("latest-one"); }}>通常の取得に戻る</button>
          <h4>全件バックアップ</h4>
          <p>対象の記事をすべて扱う重い処理です。通常の取得とは分けて条件を確認します。</p>
          <p className="field-help">全件処理と続きからの再開は、ブログ保存機能の実装時に利用できます。</p>
          {message && <p className="form-message" role="alert">{message}</p>}
          <button type="button" className="secondary-button" disabled={!authorId || confirming} onClick={() => void confirm()}>{confirming ? "確認中…" : "全件バックアップの条件を確認"}</button>
        </div>
      ) : (
        <>
          <div className="selection-field">
            <label htmlFor="selection-group">誰のブログ？</label>
            <select id="selection-group" value={group} onChange={(event) => changeGroup(event.target.value as BlogGroup)}>
              <option value="nogizaka">乃木坂46</option>
              <option value="sakurazaka">櫻坂46</option>
              <option value="hinatazaka">日向坂46</option>
            </select>
          </div>
          <div className="selection-field">
            <label htmlFor="selection-author">メンバー</label>
            <select id="selection-author" value={authorId} onChange={(event) => changeAuthor(event.target.value)} disabled={loadingAuthors || authors.length === 0}>
              <option value="">{loadingAuthors ? "読み込み中…" : "選択してください"}</option>
              {memberAuthors.length > 0 && <optgroup label="メンバー">{memberAuthors.map((author) => <option key={author.id} value={author.id}>{author.name}</option>)}</optgroup>}
              {otherAuthors.length > 0 && <optgroup label="その他のブログ">{otherAuthors.map((author) => <option key={author.id} value={author.id}>{author.name}</option>)}</optgroup>}
            </select>
            {loadingAuthors && <p className="field-help" role="status">メンバー一覧を読み込んでいます…</p>}
          </div>
          <fieldset className="selection-fieldset">
            <legend>何を保存する？</legend>
            <label className="choice-row"><input type="radio" name="selection-content" checked={content === "photos"} onChange={() => changeContent("photos")} /><span><strong>写真のみ</strong><small>記事内の写真を確認する</small></span></label>
            <label className="choice-row"><input type="radio" name="selection-content" checked={content === "blog"} onChange={() => changeContent("blog")} /><span><strong>ブログ</strong><small>PDFとMHTMLで保存する</small></span></label>
          </fieldset>
          <fieldset className="selection-fieldset range-fieldset">
            <legend>どこまで取得する？</legend>
            <label className="choice-row featured-choice"><input type="radio" name="selection-range" checked={range === "latest-one"} onChange={() => changeRange("latest-one")} /><span><strong>最新1件</strong><small>いつもの確認に</small></span></label>
            <label className="choice-row"><input type="radio" name="selection-range" checked={range === "latest-n"} onChange={() => changeRange("latest-n")} /><span><strong>最新N件</strong><small>最大{limit}記事まで</small></span></label>
            {range === "latest-n" && <div className="count-field"><label htmlFor="selection-count">記事数</label><input id="selection-count" type="number" min="2" max={limit} inputMode="numeric" value={count} onChange={(event) => { setCount(event.target.value); setPlan(null); }} /><span>件</span></div>}
            <label className="choice-row"><input type="radio" name="selection-range" checked={range === "selected"} onChange={() => changeRange("selected")} /><span><strong>記事を選ぶ</strong><small>ページを跨いで{limit}記事まで</small></span></label>
            {range === "selected" && <div className="select-entry"><span>{selectedCount} / {limit}記事を選択中</span><button type="button" className="secondary-button" disabled={!authorId} onClick={() => { setStage("articles"); setMessage(""); }}>記事選択へ進む</button></div>}
          </fieldset>
          <div className="bulk-entry"><strong>全件バックアップ</strong><p>大量の記事を扱うため、別の手順で設定します。</p><button type="button" className="text-button" disabled={!authorId} onClick={() => { changeRange("all"); setStage("bulk"); }}>全件バックアップの条件を設定</button></div>
          {message && <div role="alert" className="catalog-error"><p className="form-message">{message}</p>{authors.length === 0 && <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>一覧を再読み込み</button>}</div>}
          {range !== "selected" && range !== "all" && <button type="button" className="primary-button selection-confirm" disabled={!authorId || confirming} onClick={() => void confirm()}>{confirming ? "確認中…" : "この条件を確認"}</button>}
          {plan && (
            <div className="selection-summary" role="status">
              <strong>取得条件を確認しました</strong>
              <p>{plan.author.name}・{contentName[plan.content]}・{rangeName[plan.range]}{plan.range === "latest-n" ? `（${plan.count}件）` : plan.range === "selected" ? `（${plan.urls?.length}件）` : ""}</p>
              {singleBlogUrl ? <button type="button" className="primary-button" disabled={busy} onClick={() => void onSaveBlog(singleBlogUrl)}>{busy ? "保存中…" : "この1件を保存"}</button>
                : <p className="field-help">{plan.content === "photos" ? "写真の表示と保存は次の機能で利用できます。" : "複数記事と全件バックアップの実行は次の機能で利用できます。"}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
