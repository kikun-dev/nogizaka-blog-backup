import type { LocalJob } from "@/server/job-store";

export function PhotoGallery({ job }: { job: LocalJob }) {
  const articles = job.photoArticles ?? [];
  const totalPhotos = articles.reduce((sum, article) => sum + article.photos.length, 0);
  return (
    <section className="photo-gallery" aria-label="ブログごとの写真">
      <div className="photo-gallery-heading">
        <p>{articles.length}件のブログ・写真{totalPhotos}枚</p>
        {job.photoZipReady && <a className="secondary-button photo-zip-link" href={`/api/photo-jobs/${job.id}/zip`}>写真をZIPで保存</a>}
      </div>
      <p className="photo-save-help">写真を長押しして保存します。<br />iPhone・iPad：「写真に保存」／Android：「画像をダウンロード」</p>
      {articles.map((article) => (
        <article className="photo-article" key={article.id}>
          <div className="photo-article-heading">
            <p>{article.authorName}</p>
            <h4>{article.title}</h4>
            <time>更新日時: {article.date || "日時不明"}</time>
          </div>
          {article.error && <p className="form-message" role="alert">このブログの写真を取得できませんでした。</p>}
          {!article.error && article.detected === 0 && <p className="photo-empty">保存対象の写真が見つかりませんでした。</p>}
          {article.failed > 0 && <p className="photo-partial" role="status">写真{article.detected}枚中{article.photos.length}枚を取得しました。取得できなかった写真があります。</p>}
          <div className="photo-list">
            {article.photos.map((photo, index) => {
              const source = `/api/photo-jobs/${job.id}/files/${article.id}/${photo.name}`;
              return <figure key={photo.name}>
                {/* A regular image element keeps the browser's native long-press save menu. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={source} alt={`${article.title}の写真 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" />
                <figcaption><span>写真 {index + 1} / {article.photos.length}</span><a href={source} download={photo.name}>個別に保存</a></figcaption>
              </figure>;
            })}
          </div>
        </article>
      ))}
      {job.photoZipReady && <p className="field-help photo-zip-help">ZIPは「ファイル」アプリなどに保存されます。写真アプリには直接入りません。</p>}
    </section>
  );
}
