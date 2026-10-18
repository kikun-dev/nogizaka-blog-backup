import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "坂道ブログ保存ツール",
  description: "乃木坂46・櫻坂46・日向坂46の公式ブログを保存するツール",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
