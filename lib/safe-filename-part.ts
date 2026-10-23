export function safeFilenamePart(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/\s+/g, " ").replace(/[. ]+$/g, "").replace(/^[. ]+/g, "")
    .slice(0, 40).replace(/[. ]+$/g, "");
  return !cleaned || /^_+$/.test(cleaned) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cleaned)
    ? fallback : cleaned;
}
