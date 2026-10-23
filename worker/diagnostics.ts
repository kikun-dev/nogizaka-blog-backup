type ErrorLike = { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };

function errorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : undefined;
}

function redactMessage(value: string): string {
  let message = value;
  for (const name of ["SUPABASE_SECRET_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SHARED_ACCESS_CODE", "LOCAL_ACCESS_TOKEN"]) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) message = message.replaceAll(secret, "[redacted]");
  }
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(apikey|token|secret|password)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .slice(0, 300);
}

export function errorDiagnostic(error: unknown): { errorType: string; errorCode?: string; errorMessage?: string } {
  const record = error && typeof error === "object" ? error as ErrorLike : {};
  const cause = record.cause && typeof record.cause === "object" ? record.cause as ErrorLike : {};
  const name = typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,49}$/.test(record.name)
    ? record.name : "unknown";
  const code = errorCode(record.code) ?? errorCode(cause.code);
  const message = typeof record.message === "string" ? redactMessage(record.message) : undefined;
  return { errorType: name, ...(code ? { errorCode: code } : {}), ...(message ? { errorMessage: message } : {}) };
}
