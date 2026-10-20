"use client";

import { useEffect, useRef, useState } from "react";
import type { BlogArticlePage, BlogAuthor, BlogGroup } from "@/lib/catalog/types";
import { paginateArticles, type ArticleCursor, type ListedArticle, type SelectionArticlePage } from "@/lib/selection-pages";
import { ALL_AUTHORS_ID, SELECTION_LIMITS, validateSelection, type SelectionContent, type SelectionPlan, type SelectionRange, type SelectionRequest } from "@/lib/selection";

type Stage = "conditions" | "articles";

const contentName = { photos: "写真のみ", blog: "ブログ" } as const;
const groupName = { nogizaka: "乃木坂46", sakurazaka: "櫻坂46", hinatazaka: "日向坂46" } as const;
const rangeName = {
  "latest-one": "最新1件",
  "latest-n": "最新N件",
  selected: "選んだブログ",
  all: "全件バックアップ",
} as const;

export function AcquisitionPlanner({ token, busy, onSaveBlog, onSavePhotos }: {
  token: string;
  busy: boolean;
  onSaveBlog: (selection: SelectionRequest) => Promise<void>;
  onSavePhotos: (selection: SelectionRequest) => Promise<void>;
}) {
  const [group, setGroup] = useState<BlogGroup>("nogizaka");
  const [authors, setAuthors] = useState<BlogAuthor[]>([]);
  const [authorId, setAuthorId] = useState("");
  const [content, setContent] = useState<SelectionContent>("photos");
  const [range, setRange] = useState<SelectionRange>("latest-one");
  const [count, setCount] = useState("5");
  const [stage, setStage] = useState<Stage>("conditions");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSources, setPageSources] = useState<ArticleCursor[]>([{ sourcePage: 1, offset: 0 }]);
  const [articlePage, setArticlePage] = useState<SelectionArticlePage | null>(null);
  const [selected, setSelected] = useState<Record<string, ListedArticle>>({});
  const [plan, setPlan] = useState<SelectionPlan | null>(null);
  const [loadingAuthors, setLoadingAuthors] = useState(false);
  const [loadingArticles, setLoadingArticles] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const confirmationVersion = useRef(0);
  const confirmationController = useRef<AbortController | null>(null);
  const limit = SELECTION_LIMITS[content];
  const selectedCount = Object.keys(selected).length;
  const memberAuthors = authors.filter((author) => author.type === "member");
  const otherAuthors = authors.filter((author) => author.type !== "member");
  const sourceCursor = pageSources[pageNumber - 1];
  const groupWide = authorId === ALL_AUTHORS_ID;

  function invalidateConfirmation() {
    confirmationVersion.current += 1;
    confirmationController.current?.abort();
    confirmationController.current = null;
    setConfirming(false);
    setPlan(null);
  }

  useEffect(() => () => confirmationController.current?.abort(), [token]);

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
    if (stage !== "articles" || !authorId || !sourceCursor) return;
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
          if (!response.ok || !data.articles) throw new Error(data.error ?? "ブログ一覧を取得できませんでした。");
          return data.articles;
        }
        const first = await fetchSourcePage(sourceCursor.sourcePage);
        const second = first.hasNext && first.items.length - sourceCursor.offset < limit
          ? await fetchSourcePage(sourceCursor.sourcePage + 1)
          : null;
        if (!controller.signal.aborted) {
          const displayPage = paginateArticles(first, second, sourceCursor, pageNumber, limit);
          setArticlePage(displayPage);
          setPageSources((current) => {
            const next = current.slice(0, pageNumber);
            if (displayPage.nextCursor) next[pageNumber] = displayPage.nextCursor;
            return next;
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "ブログ一覧を取得できませんでした。");
      } finally {
        if (!controller.signal.aborted) setLoadingArticles(false);
      }
    }
    void loadArticles();
    return () => controller.abort();
  }, [stage, group, authorId, pageNumber, sourceCursor, limit, token, retry]);

  function changeGroup(value: BlogGroup) {
    invalidateConfirmation();
    setGroup(value);
    setAuthors([]);
    setAuthorId("");
    setSelected({});
    setArticlePage(null);
    setPageNumber(1);
    setPageSources([{ sourcePage: 1, offset: 0 }]);
    setMessage("");
    setStage("conditions");
  }

  function changeAuthor(value: string) {
    invalidateConfirmation();
    setAuthorId(value);
    if (value === ALL_AUTHORS_ID && range === "all") setRange("latest-one");
    setSelected({});
    setArticlePage(null);
    setPageNumber(1);
    setPageSources([{ sourcePage: 1, offset: 0 }]);
    setMessage("");
  }

  function changeContent(value: SelectionContent) {
    invalidateConfirmation();
    setContent(value);
    if (value === "photos" && range === "all") setRange("latest-one");
    setSelected({});
    setArticlePage(null);
    setPageNumber(1);
    setPageSources([{ sourcePage: 1, offset: 0 }]);
    setMessage("");
  }

  function changeRange(value: SelectionRange) {
    invalidateConfirmation();
    setRange(value);
    setMessage("");
  }

  function changePage(value: number) {
    invalidateConfirmation();
    setPageNumber(value);
    setArticlePage(null);
    setMessage("");
  }

  function toggleArticle(item: ListedArticle) {
    invalidateConfirmation();
    if (!selected[item.article.id] && selectedCount >= limit) {
      setMessage(`${contentName[content]}は最大${limit}件までです。ほかのブログを選ぶには、先に選択を解除してください。`);
      return;
    }
    setMessage("");
    setSelected((current) => {
      if (current[item.article.id]) {
        const next = { ...current };
        delete next[item.article.id];
        return next;
      }
      return { ...current, [item.article.id]: item };
    });
  }

  function togglePage() {
    if (!articlePage) return;
    invalidateConfirmation();
    const allSelected = articlePage.items.length > 0 && articlePage.items.every(({ article }) => selected[article.id]);
    if (allSelected) {
      setSelected((current) => {
        const next = { ...current };
        for (const { article } of articlePage.items) delete next[article.id];
        return next;
      });
      setMessage("");
      return;
    }
    const toAdd = articlePage.items.filter(({ article }) => !selected[article.id]);
    if (selectedCount + toAdd.length > limit) {
      setMessage(`残り${limit - selectedCount}件まで選べます。このページを一括選択するには、先に選択を減らしてください。`);
      return;
    }
    setSelected((current) => Object.fromEntries([
      ...Object.entries(current),
      ...toAdd.map((item) => [item.article.id, item] as const),
    ]));
    setMessage("");
  }

  async function confirm() {
    if (!authorId || confirming) return;
    const request: SelectionRequest = { group, authorId, content, range };
    if (range === "latest-n") request.count = Number(count);
    if (range === "selected") request.articles = Object.values(selected).map(({ article, sourcePage }) => ({ url: article.url, sourcePage }));
    const version = ++confirmationVersion.current;
    const controller = new AbortController();
    confirmationController.current = controller;
    setConfirming(true);
    setPlan(null);
    setMessage("");
    try {
      const response = await fetch("/api/selections", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const data = await response.json() as { plan?: SelectionPlan; error?: string };
      if (!response.ok || !data.plan) throw new Error(data.error ?? "取得条件を確認できませんでした。");
      if (JSON.stringify(validateSelection(request)) !== JSON.stringify(validateSelection(data.plan))) {
        throw new Error("確認結果が現在の取得条件と一致しません。もう一度確認してください。");
      }
      if (version === confirmationVersion.current && !controller.signal.aborted) {
        setPlan(data.plan);
        setStage("conditions");
      }
    } catch (error) {
      if (version === confirmationVersion.current && !controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : "取得条件を確認できませんでした。");
      }
    } finally {
      if (version === confirmationVersion.current) {
        confirmationController.current = null;
        setConfirming(false);
      }
    }
  }

  const selectedOnPage = articlePage?.items.length ? articlePage.items.every(({ article }) => selected[article.id]) : false;
  return (
    <section className="selection-flow" aria-labelledby="selection-heading">
      <h3 id="selection-heading">公式サイトから条件を選ぶ</h3>
      {stage === "articles" ? (
        <div className="article-screen">
          <button type="button" className="text-button" onClick={() => { invalidateConfirmation(); setStage("conditions"); setMessage(""); }}>条件の設定に戻る</button>
          <h4>{groupWide ? `${groupName[group]}全体` : authors.find((author) => author.id === authorId)?.name}のブログを選ぶ</h4>
          <p className="field-help">新しい順に表示します。ページを移動しても選択は残ります。</p>
          {loadingArticles && <p role="status" className="field-help">ブログを読み込んでいます…</p>}
          {articlePage && (
            <>
              <div className="article-page-heading">
                <span>{articlePage.page}ページ目・{articlePage.items.length}件</span>
                <button type="button" className="text-button" onClick={togglePage} disabled={articlePage.items.length === 0}>
                  {selectedOnPage ? "このページの選択を解除" : "このページをすべて選択"}
                </button>
              </div>
              {articlePage.items.length === 0 ? <p className="field-help">このページにブログはありません。</p> : (
                <ul className="selection-article-list">
                  {articlePage.items.map((item) => <li key={item.article.id}>
                    <label className="selection-article-row">
                      <input type="checkbox" checked={Boolean(selected[item.article.id])} onChange={() => toggleArticle(item)} disabled={!selected[item.article.id] && selectedCount >= limit} />
                      <span><strong>{item.article.title}</strong>{groupWide && <small>{item.article.author.name}</small>}{item.article.excerpt && <small>{item.article.excerpt}</small>}<time>{item.article.date || "日付なし"}</time></span>
                    </label>
                  </li>)}
                </ul>
              )}
              <div className="catalog-pagination">
                <button type="button" className="secondary-button" disabled={pageNumber === 1 || loadingArticles} onClick={() => changePage(pageNumber - 1)}>前のページ</button>
                <button type="button" className="secondary-button" disabled={!articlePage.nextCursor || loadingArticles} onClick={() => changePage(pageNumber + 1)}>次のページ</button>
              </div>
            </>
          )}
          {message && <div role="alert"><p className="form-message">{message}</p>{!articlePage && <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>ブログ一覧を再読み込み</button>}</div>}
          {selectedCount >= limit && <p className="selection-limit-note" role="status">{contentName[content]}の上限は{limit}件です。別のブログを選ぶには、選択を解除してください。</p>}
          <div className="selection-sticky-bar" aria-live="polite">
            <span><strong>{selectedCount}</strong>件選択中（上限{limit}件）</span>
            <button type="button" className="primary-button" disabled={selectedCount === 0 || confirming} onClick={() => void confirm()}>{confirming ? "確認中…" : "選択を確定"}</button>
          </div>
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
              {authors.length > 0 && <option value={ALL_AUTHORS_ID}>全件（{groupName[group]}全体の最新ブログ）</option>}
              {memberAuthors.length > 0 && <optgroup label="メンバー">{memberAuthors.map((author) => <option key={author.id} value={author.id}>{author.name}</option>)}</optgroup>}
              {otherAuthors.length > 0 && <optgroup label="その他のブログ">{otherAuthors.map((author) => <option key={author.id} value={author.id}>{author.name}</option>)}</optgroup>}
            </select>
            {loadingAuthors && <p className="field-help" role="status">メンバー一覧を読み込んでいます…</p>}
          </div>
          <fieldset className="selection-fieldset">
            <legend>何を保存する？</legend>
            <label className="choice-row"><input type="radio" name="selection-content" checked={content === "photos"} onChange={() => changeContent("photos")} /><span><strong>写真のみ</strong><small>ブログ内の写真を確認する</small></span></label>
            <label className="choice-row"><input type="radio" name="selection-content" checked={content === "blog"} onChange={() => changeContent("blog")} /><span><strong>ブログ</strong><small>PDFとMHTMLで保存する</small></span></label>
          </fieldset>
          <fieldset className="selection-fieldset range-fieldset">
            <legend>どこまで取得する？</legend>
            <label className="choice-row"><input type="radio" name="selection-range" checked={range === "latest-one"} onChange={() => changeRange("latest-one")} /><span><strong>最新1件</strong><small>いつもの確認に</small></span></label>
            <label className="choice-row"><input type="radio" name="selection-range" checked={range === "latest-n"} onChange={() => changeRange("latest-n")} /><span><strong>最新N件</strong><small>最大{limit}件まで</small></span></label>
            {range === "latest-n" && <div className="count-field"><label htmlFor="selection-count">ブログの件数</label><input id="selection-count" type="number" min="2" max={limit} inputMode="numeric" value={count} onChange={(event) => { invalidateConfirmation(); setCount(event.target.value); }} /><span>件</span></div>}
            <label className="choice-row"><input type="radio" name="selection-range" checked={range === "selected"} onChange={() => changeRange("selected")} /><span><strong>ブログを選ぶ</strong><small>ページを跨いで{limit}件まで</small></span></label>
            {range === "selected" && <div className="select-entry"><span>{selectedCount}件選択中（上限{limit}件）</span><button type="button" className="secondary-button" disabled={!authorId} onClick={() => { invalidateConfirmation(); setStage("articles"); setMessage(""); }}>ブログ選択へ進む</button></div>}
            <label className="choice-row"><input type="radio" name="selection-range" checked={range === "all"} disabled={content !== "blog" || groupWide} onChange={() => changeRange("all")} aria-describedby={range === "all" ? "bulk-range-note" : undefined} /><span><strong>全件バックアップ</strong><small>{groupWide ? "グループ全体では選べません" : content === "blog" ? "このメンバーのブログをすべて保存" : "ブログ保存を選ぶと利用できます"}</small></span></label>
            {content === "blog" && range === "all" && <div id="bulk-range-note" className="bulk-notice" role="note">
              <strong>全件バックアップについて</strong>
              <p>公式一覧の最後まで自動で取得し、通常は完了後に1つのZIPにまとめます。内部では10件ずつ処理するため、件数に応じて長時間かかります。処理中、ほかの保存ジョブは待機します。</p>
              <p>1つのZIPにまとめられる範囲は最大5,000件・保存データ19 GB・ZIP20 GBです。件数や容量の上限に達した場合は保存済み分のZIPを作り、結果画面から続きの位置で次のZIPを作れます。作成中は開発PCに保存データとZIPの両方を置く空き容量が必要です。</p>
              <p>4 GB以上のZIPはWindows標準の「すべて展開」でエラーになる場合があります。ダウンロード後は7-ZipなどZIP64対応アプリで展開してください。</p>
            </div>}
          </fieldset>
          {message && <div role="alert" className="catalog-error"><p className="form-message">{message}</p>{authors.length === 0 && <button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>一覧を再読み込み</button>}</div>}
          {range !== "selected" && <button type="button" className="primary-button selection-confirm" disabled={!authorId || confirming} onClick={() => void confirm()}>{confirming ? "確認中…" : "この条件を確認"}</button>}
          {plan && (
            <div className="selection-summary" role="status">
              <strong>取得条件を確認しました</strong>
              <p>{plan.authorId === ALL_AUTHORS_ID ? `${groupName[plan.group]}全体` : plan.author.name}・{contentName[plan.content]}・{rangeName[plan.range]}{plan.range === "latest-n" ? `（${plan.count}件）` : plan.range === "selected" ? `（${plan.articles?.length}件）` : ""}</p>
              {plan.range === "latest-n" && plan.previewArticles && plan.previewArticles.length < (plan.count ?? 0) &&
                <p className="field-help">公式一覧で確認できたブログは{plan.previewArticles.length}件です。</p>}
              {plan.previewArticles && plan.previewArticles.length > 0 && (
                <div className="selection-summary-preview">
                  <h4>対象のブログ</h4>
                  <ul>{plan.previewArticles.map((article) => <li key={article.id}>
                    <strong>{article.title}</strong>
                    {plan.authorId === ALL_AUTHORS_ID && <small>{article.author.name}</small>}
                    <time>更新日時: {article.date || "日時不明"}</time>
                  </li>)}</ul>
                </div>
              )}
              {plan.content === "photos" && plan.range !== "all" ?
                <button type="button" className="primary-button" disabled={busy} onClick={() => void onSavePhotos(validateSelection(plan))}>{busy ? "取得中…" : `写真を取得（${plan.previewArticles?.length ?? 0}件）`}</button>
                : plan.content === "blog" ? <button type="button" className="primary-button" disabled={busy} onClick={() => void onSaveBlog(validateSelection(plan))}>{busy ? "保存中…" : plan.range === "all" ? "全件バックアップを開始" : `ブログを保存（${plan.previewArticles?.length ?? 0}件）`}</button>
                : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
