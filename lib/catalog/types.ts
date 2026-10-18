export type BlogGroup = "nogizaka" | "sakurazaka" | "hinatazaka";
export type BlogAuthorType = "member" | "generation" | "staff" | "mascot" | "other";

export type BlogAuthor = {
  id: string;
  name: string;
  type: BlogAuthorType;
  group: BlogGroup;
  listUrl: string;
};

export type BlogArticle = {
  id: string;
  title: string;
  excerpt?: string;
  date: string;
  url: string;
  author: BlogAuthor;
};

export type BlogArticlePage = {
  items: BlogArticle[];
  page: number;
  hasNext: boolean;
};
