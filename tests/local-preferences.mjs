import assert from "node:assert/strict";
import { emptyPreferences, favoriteFromAuthor, favoriteKey, parsePreferences, serializePreferences, toggleFavorite } from "../lib/local-preferences.ts";

const author = { group: "hinatazaka", id: "000", name: "ポカ", type: "mascot", listUrl: "https://example.com" };
const staff = { group: "nogizaka", id: "000", name: "運営ブログ", type: "staff", listUrl: "https://example.com" };
const generation = { group: "nogizaka", id: "5", name: "5期生", type: "generation", listUrl: "https://example.com" };
const favorites = toggleFavorite(toggleFavorite([], author), staff);
assert.deepEqual(favorites.map(favoriteKey), ["hinatazaka:000", "nogizaka:000"]);
assert.deepEqual(favoriteFromAuthor(generation), { group: "nogizaka", authorId: "5", authorName: "5期生", authorType: "generation" });
assert.deepEqual(toggleFavorite(favorites, author).map(favoriteKey), ["nogizaka:000"]);

const preferences = { favorites, lastSelection: { group: "hinatazaka", authorId: "000", content: "photos", range: "latest-n", count: 5 } };
assert.deepEqual(parsePreferences(serializePreferences(preferences)), preferences);
assert.deepEqual(parsePreferences(null), emptyPreferences());
assert.deepEqual(parsePreferences("broken json"), emptyPreferences());
assert.deepEqual(parsePreferences(JSON.stringify({ version: 2, favorites })), emptyPreferences());

const malformed = { version: 1, favorites: [
  { ...favoriteFromAuthor(author), authorId: "../1" },
  favoriteFromAuthor(author),
  favoriteFromAuthor(author),
  { ...favoriteFromAuthor(staff), authorType: "admin" },
], lastSelection: { group: "hinatazaka", authorId: "all", content: "blog", range: "all", count: 5 } };
assert.deepEqual(parsePreferences(JSON.stringify(malformed)).favorites, [favoriteFromAuthor(author)]);
assert.equal(parsePreferences(JSON.stringify(malformed)).lastSelection, null);

const selected = { version: 1, favorites: [], lastSelection: { group: "nogizaka", authorId: "5", content: "blog", range: "selected", count: 5, articles: [{ url: "https://example.com" }] } };
assert.deepEqual(parsePreferences(JSON.stringify(selected)).lastSelection, { group: "nogizaka", authorId: "5", content: "blog", range: "selected", count: 5 });
const overLimit = { ...selected, lastSelection: { ...selected.lastSelection, range: "latest-n", count: 20 } };
assert.equal(parsePreferences(JSON.stringify(overLimit)).lastSelection.count, 10);

console.log("Local preferences tests passed.");
