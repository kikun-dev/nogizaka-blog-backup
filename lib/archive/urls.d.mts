export type Group = {
  key: string;
  directory: string;
  label: string;
  hosts: string[];
  pathPattern: RegExp;
  canonicalCd: string;
  previousLabels: string[];
};

export class UserInputError extends Error {
  showRetryHint: false;
}
export function detectGroup(url: URL): Group;
export function normalizeArticleUrl(rawUrl: string, baseUrl?: string, expectedGroupKey?: string): string;
