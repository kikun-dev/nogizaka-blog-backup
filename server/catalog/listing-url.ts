export function isExpectedListingUrl(requestedUrl: string, actualUrl: string): boolean {
  const requested = new URL(requestedUrl);
  const actual = new URL(actualUrl);
  return actual.origin === requested.origin &&
    actual.pathname === requested.pathname &&
    actual.searchParams.get("ct") === requested.searchParams.get("ct") &&
    actual.searchParams.get("page") === requested.searchParams.get("page");
}
