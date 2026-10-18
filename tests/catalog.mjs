import assert from "node:assert/strict";
import { chromium } from "playwright";
import { authorListUrl, articlesUrl, isAuthorId, readArticles, readAuthors } from "../server/catalog/adapters.ts";

assert.equal(isAuthorId("000"), true);
assert.equal(isAuthorId("../detail/1"), false);
assert.equal(articlesUrl("hinatazaka", "000", 2), "https://www.hinatazaka46.com/s/official/diary/member/list?ct=000&page=1");

const browser = await chromium.launch();
try {
  const fixtures = [
    {
      group: "nogizaka",
      root: "https://www.nogizaka46.com",
      author: '<a class="ba--ml__one__a" href="/s/n46/diary/MEMBER/list?ct=40003"><p class="ba--ml__one__name">運営スタッフ</p></a>',
      article: '<div class="bl--list"><a class="bl--card" href="/s/n46/diary/detail/101?cd=MEMBER"><p class="bl--card__ttl">お知らせ</p><p class="bl--card__date">2026.10.19 12:00</p></a></div>',
      type: "staff",
      title: "お知らせ",
    },
    {
      group: "sakurazaka",
      root: "https://sakurazaka46.com",
      author: '<div class="com-blog-circle"><a href="/s/s46/diary/blog/list?ct=70"><p class="name">浅井 恋乃未</p></a><a href="/s/s46/diary/blog/list?ct=06"><p class="name">小池 美波</p></a></div>',
      article: '<ul class="com-blog-part"><li class="box"><a href="/s/s46/diary/detail/101?cd=blog"><p class="date-title"><span class="date">2026/10/19</span><span class="title">　</span></p><p class="lead">記事の冒頭文です</p></a></li></ul><ul class="com-blog-minipart"><li class="box"><a href="/s/s46/diary/detail/999?cd=blog">共通新着</a></li></ul>',
      type: "member",
      title: "無題の記事",
    },
    {
      group: "hinatazaka",
      root: "https://www.hinatazaka46.com",
      author: '<a class="p-blog-face__list" href="/s/official/diary/member/list?ct=000"><span class="c-blog-face__name">ポカ</span></a>',
      article: '<div class="p-blog-article"><div class="c-blog-article__title">ポカの日記</div><div class="c-blog-article__date">2026.10.19 12:00</div><a href="/s/official/diary/detail/101?cd=member">個別ページ</a><div class="c-blog-article__text"><img src="https://invalid.example/photo.jpg"></div></div>',
      type: "mascot",
      title: "ポカの日記",
    },
  ];

  for (const fixture of fixtures) {
    const page = await browser.newPage();
    await page.setContent(`<base href="${fixture.root}">${fixture.author}${fixture.article}<a href="?page=1">2</a>`);
    const authors = await readAuthors(fixture.group, page);
    assert.equal(authors.length, 1);
    assert.equal(authors[0].type, fixture.type);
    assert.equal(authors[0].listUrl, authorListUrl(fixture.group, authors[0].id));
    const articles = await readArticles(fixture.group, authors[0], page, 1);
    assert.equal(articles.items.length, 1, `${fixture.group}: only the selected author's list`);
    assert.equal(articles.items[0].title, fixture.title);
    assert.equal(articles.items[0].author.id, authors[0].id);
    assert.equal(articles.items[0].date.startsWith("2026-10-19"), true);
    assert.equal(articles.hasNext, true);
    await page.close();
  }
  console.log("Catalog adapter fixtures passed");
} finally {
  await browser.close();
}
