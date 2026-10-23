import type { Metadata } from "next";
import "./globals.css";

const deploymentHost = process.env.VERCEL_ENV === "production"
  ? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
  : process.env.VERCEL_URL;

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? (deploymentHost ? `https://${deploymentHost}` : "http://localhost:3000")),
  title: "SakaClip（サカクリップ）｜坂道ブログ保存ツール",
  applicationName: "SakaClip",
  description: "乃木坂46・櫻坂46・日向坂46の公式ブログから写真・ブログを保存できる、非公式の個人制作ツールです。",
  openGraph: {
    title: "SakaClip（サカクリップ）｜坂道ブログ保存ツール",
    description: "乃木坂46・櫻坂46・日向坂46の公式ブログから写真・ブログを保存。非公式の個人制作ツールです。",
    siteName: "SakaClip",
    locale: "ja_JP",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SakaClip（サカクリップ）｜坂道ブログ保存ツール",
    description: "坂道グループの公式ブログから写真・ブログを保存。非公式の個人制作ツールです。",
  },
  appleWebApp: {
    title: "SakaClip",
    capable: true,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
