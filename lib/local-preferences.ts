import type { BlogAuthor, BlogAuthorType, BlogGroup } from "./catalog/types";

export const PREFERENCES_KEY = "sakamichi-preferences-v1";
const MAX_FAVORITES = 30;

export type FavoriteAuthor = Pick<BlogAuthor, "group"> & {
  authorId: string;
  authorName: string;
  authorType: BlogAuthorType;
};

export type LocalPreferences = { favorites: FavoriteAuthor[] };

export const emptyPreferences = (): LocalPreferences => ({ favorites: [] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isGroup = (value: unknown): value is BlogGroup =>
  value === "nogizaka" || value === "sakurazaka" || value === "hinatazaka";
const isAuthorType = (value: unknown): value is BlogAuthorType =>
  value === "member" || value === "generation" || value === "staff" || value === "mascot" || value === "other";
const isAuthorId = (value: unknown): value is string => typeof value === "string" && /^\d{1,8}$/.test(value);

export function favoriteFromAuthor(author: BlogAuthor): FavoriteAuthor {
  return { group: author.group, authorId: author.id, authorName: author.name, authorType: author.type };
}

export function favoriteKey(favorite: Pick<FavoriteAuthor, "group" | "authorId">): string {
  return `${favorite.group}:${favorite.authorId}`;
}

export function parsePreferences(raw: string | null): LocalPreferences {
  if (!raw) return emptyPreferences();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) return emptyPreferences();
    const favorites: FavoriteAuthor[] = [];
    const seen = new Set<string>();
    if (Array.isArray(value.favorites)) {
      for (const entry of value.favorites.slice(0, MAX_FAVORITES * 2)) {
        if (!isRecord(entry) || !isGroup(entry.group) || !isAuthorId(entry.authorId) ||
          typeof entry.authorName !== "string" || !entry.authorName.trim() || entry.authorName.length > 100 ||
          !isAuthorType(entry.authorType)) continue;
        const favorite = { group: entry.group, authorId: entry.authorId, authorName: entry.authorName, authorType: entry.authorType };
        const key = favoriteKey(favorite);
        if (!seen.has(key)) { favorites.push(favorite); seen.add(key); }
        if (favorites.length === MAX_FAVORITES) break;
      }
    }
    return { favorites };
  } catch { return emptyPreferences(); }
}

export function serializePreferences(preferences: LocalPreferences): string {
  return JSON.stringify({ version: 1, favorites: preferences.favorites });
}

export function toggleFavorite(favorites: FavoriteAuthor[], author: BlogAuthor): FavoriteAuthor[] {
  const favorite = favoriteFromAuthor(author);
  const key = favoriteKey(favorite);
  if (favorites.some((entry) => favoriteKey(entry) === key)) return favorites.filter((entry) => favoriteKey(entry) !== key);
  return [...favorites, favorite].slice(-MAX_FAVORITES);
}
