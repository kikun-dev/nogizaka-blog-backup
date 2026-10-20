import assert from "node:assert/strict";
import { emptyPreferences, favoriteFromAuthor, favoriteKey, parsePreferences, serializePreferences, toggleFavorite } from "../lib/local-preferences.ts";

const author = { group: "hinatazaka", id: "000", name: "ポカ", type: "mascot", listUrl: "https://example.com" };
const staff = { group: "nogizaka", id: "000", name: "運営ブログ", type: "staff", listUrl: "https://example.com" };
const generation = { group: "nogizaka", id: "5", name: "5期生", type: "generation", listUrl: "https://example.com" };
const favorites = toggleFavorite(toggleFavorite([], author), staff);
assert.deepEqual(favorites.map(favoriteKey), ["hinatazaka:000", "nogizaka:000"]);
assert.deepEqual(favoriteFromAuthor(generation), { group: "nogizaka", authorId: "5", authorName: "5期生", authorType: "generation" });
assert.deepEqual(toggleFavorite(favorites, author).map(favoriteKey), ["nogizaka:000"]);

const preferences = { favorites };
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
assert.deepEqual(parsePreferences(JSON.stringify(malformed)), { favorites: [favoriteFromAuthor(author)] });
const legacy = JSON.stringify({ version: 1, ...preferences, lastSelection: { group: "hinatazaka", authorId: "000", content: "photos", range: "latest-one", count: 5 } });
assert.deepEqual(parsePreferences(legacy), preferences);
assert.equal(serializePreferences(parsePreferences(legacy)).includes("lastSelection"), false);

console.log("Local preferences tests passed.");
