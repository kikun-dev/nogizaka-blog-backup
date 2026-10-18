import assert from "node:assert/strict";
import { SELECTION_LIMITS, SelectionError, validateSelection } from "../lib/selection.ts";

const base = { group: "hinatazaka", authorId: "000", content: "photos" };
const article = "https://www.hinatazaka46.com/s/official/diary/detail/123?ima=0000&cd=member";
assert.equal(SELECTION_LIMITS.photos, 20);
assert.equal(SELECTION_LIMITS.blog, 10);
assert.deepEqual(validateSelection({ ...base, range: "latest-one" }), { ...base, range: "latest-one" });
assert.equal(validateSelection({ ...base, range: "latest-n", count: 20 }).count, 20);
assert.equal(validateSelection({ ...base, content: "blog", range: "latest-n", count: 10 }).count, 10);
assert.equal(validateSelection({ ...base, range: "selected", urls: [article] }).urls[0].includes("ima="), false);
assert.equal(validateSelection({ ...base, range: "all" }).range, "all");

for (const invalid of [
  { ...base, range: "latest-n", count: 21 },
  { ...base, content: "blog", range: "latest-n", count: 11 },
  { ...base, range: "selected", urls: Array.from({ length: 21 }, (_, id) => article.replace("123", String(id + 1))) },
  { ...base, range: "selected", urls: [article, article] },
  { ...base, range: "selected", urls: ["https://example.com/article"] },
  { ...base, range: "latest-one", urls: [article] },
  { ...base, authorId: "../06", range: "all" },
]) {
  assert.throws(() => validateSelection(invalid), SelectionError);
}
console.log("Selection limit and URL validation passed");
