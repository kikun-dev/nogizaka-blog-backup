import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SakaClip（サカクリップ）｜坂道ブログ保存ツール",
    short_name: "SakaClip",
    description: "坂道グループの公式ブログから写真・ブログを保存する非公式の個人制作ツール",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#5134d9",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
