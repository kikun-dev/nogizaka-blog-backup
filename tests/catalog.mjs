import assert from "node:assert/strict";
import { chromium } from "playwright";
import { authorListUrl, articlesUrl, groupArticlesUrl, isAuthorId, parseNogizakaAuthorId, readArticles, readAuthors, readGroupArticles } from "../server/catalog/adapters.ts";
import { isExpectedListingUrl } from "../server/catalog/listing-url.ts";

assert.equal(isAuthorId("000"), true);
assert.equal(isAuthorId("../detail/1"), false);
assert.equal(articlesUrl("hinatazaka", "000", 2), "https://www.hinatazaka46.com/s/official/diary/member/list?ct=000&page=1");
assert.equal(groupArticlesUrl("hinatazaka", 2), "https://www.hinatazaka46.com/s/official/diary/member/list?page=1");
assert.equal(parseNogizakaAuthorId('<a class="bd--prof__tex__a" href="/s/n46/diary/MEMBER/list?ct=55397">池田 瑛紗</a>',
  "https://www.nogizaka46.com/s/n46/diary/detail/104934"), "55397");
assert.throws(() => parseNogizakaAuthorId('<a href="?ct=1">別のリンク</a>', "https://www.nogizaka46.com/"),
  /投稿者を確認できませんでした/);
assert.throws(() => parseNogizakaAuthorId('<a class="bd--prof__tex__a" href="https://example.com/s/n46/diary/MEMBER/list?ct=55397">偽リンク</a>',
  "https://www.nogizaka46.com/s/n46/diary/detail/104934"), /投稿者を確認できませんでした/);
const firstPageUrl = authorListUrl("sakurazaka", "70");
const secondPageUrl = articlesUrl("sakurazaka", "70", 2);
assert.equal(isExpectedListingUrl(firstPageUrl, `${firstPageUrl}&ima=0000`), true);
assert.equal(isExpectedListingUrl(firstPageUrl, `${firstPageUrl}&page=1`), false);
assert.equal(isExpectedListingUrl(secondPageUrl, `${secondPageUrl}&ima=0000`), true);
assert.equal(isExpectedListingUrl(secondPageUrl, firstPageUrl), false);
assert.equal(isExpectedListingUrl(secondPageUrl, `${firstPageUrl}&page=2`), false);
assert.equal(isExpectedListingUrl(secondPageUrl, secondPageUrl.replace("ct=70", "ct=06")), false);

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
      title: "無題のブログ",
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

  for (const [group, origin, card] of [
    ["sakurazaka", "https://sakurazaka46.com", (id, name) => `<ul class="com-blog-part"><li class="box"><a href="/s/s46/diary/detail/${id}"><div class="prof"><p class="name">${name}</p></div><div class="date-title"><span class="date">2026/10/20</span><span class="title">記事${id}</span></div></a></li></ul>`],
    ["hinatazaka", "https://www.hinatazaka46.com", (id, name) => `<div class="p-blog-article"><span class="c-blog-article__name">${name}</span><span class="c-blog-article__title">記事${id}</span><span class="c-blog-article__date">2026.10.20</span><a href="/s/official/diary/detail/${id}">開く</a></div>`],
  ]) {
    const page = await browser.newPage();
    const authors = ["投稿者 A", "投稿者 B"].map((name, index) => ({
      id: String(index + 1), name, type: "member", group, listUrl: authorListUrl(group, String(index + 1)),
    }));
    await page.setContent(`<base href="${origin}">${card(101, authors[0].name)}${card(102, authors[1].name)}`);
    const listing = await readGroupArticles(group, authors, page, 1);
    assert.deepEqual(listing.items.map(({ author }) => author.id), ["1", "2"]);
    await assert.rejects(readGroupArticles(group, authors.slice(0, 1), page, 1), /投稿者を特定できませんでした/);
    await page.close();
  }
  console.log("Catalog adapter fixtures passed");
} finally {
  await browser.close();
}
