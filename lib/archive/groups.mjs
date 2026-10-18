export const GROUPS = [
  {
    key: "nogizaka",
    directory: "Nogizaka",
    label: "乃木坂46",
    hosts: ["www.nogizaka46.com", "nogizaka46.com"],
    pathPattern: /^\/s\/n46\/diary\/detail\/\d+\/?$/,
    articleUrlExample:
      "https://www.nogizaka46.com/s/n46/diary/detail/104598?cd=MEMBER",
    canonicalCd: "MEMBER",
    previousLabels: ["前の記事", "前へ"],
  },
  {
    key: "sakurazaka",
    directory: "Sakurazaka",
    label: "櫻坂46",
    hosts: ["sakurazaka46.com", "www.sakurazaka46.com"],
    pathPattern: /^\/s\/s46\/diary\/detail\/\d+\/?$/,
    articleUrlExample:
      "https://sakurazaka46.com/s/s46/diary/detail/68997?cd=blog",
    canonicalCd: "blog",
    previousLabels: ["前へ", "前の記事"],
  },
  {
    key: "hinatazaka",
    directory: "Hinatazaka",
    label: "日向坂46",
    hosts: ["www.hinatazaka46.com", "hinatazaka46.com"],
    pathPattern: /^\/s\/official\/diary\/detail\/\d+\/?$/,
    memberListPattern:
      /^\/s\/official\/diary\/member\/list\/?$/,
    articleUrlExample:
      "https://www.hinatazaka46.com/s/official/diary/detail/69468?cd=member",
    canonicalCd: "member",
    previousLabels: ["前へ", "前の記事"],
  },
];

export const GROUP_BY_KEY = new Map(
  GROUPS.map((group) => [group.key, group]),
);
