import type { PublicJobRow } from "./public-store";

const groups: Record<string, { display: string; ascii: string }> = {
  nogizaka: { display: "乃木坂46", ascii: "nogizaka46" },
  sakurazaka: { display: "櫻坂46", ascii: "sakurazaka46" },
  hinatazaka: { display: "日向坂46", ascii: "hinatazaka46" },
};

export function safeFilenamePart(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/\s+/g, " ").replace(/[. ]+$/g, "").replace(/^[. ]+/g, "")
    .slice(0, 40).replace(/[. ]+$/g, "");
  return !cleaned || /^_+$/.test(cleaned) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cleaned)
    ? fallback : cleaned;
}

export function publicZipFilename(job: Pick<PublicJobRow,
  "kind" | "author_group" | "author_name" | "author_id" | "finished_at" | "updated_at">):
  { unicode: string; ascii: string } {
  const group = groups[job.author_group ?? ""] ?? { display: "坂道", ascii: "sakamichi" };
  const timestamp = job.finished_at ?? job.updated_at;
  const date = Number.isFinite(Date.parse(timestamp))
    ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(timestamp)) : "unknown-date";
  const member = safeFilenamePart(job.author_name, "メンバー");
  const memberIdPart = safeFilenamePart(job.author_id, "member").replace(/[^A-Za-z0-9_-]/g, "_");
  const memberId = /^_+$/.test(memberIdPart) ? "member" : memberIdPart;
  const kind = job.kind === "photos" ? "写真" : "ブログ";
  const asciiKind = job.kind === "photos" ? "photos" : "blogs";
  return {
    unicode: `${group.display}-${member}-${date}-${kind}.zip`,
    ascii: `${group.ascii}-${memberId}-${date}-${asciiKind}.zip`,
  };
}
