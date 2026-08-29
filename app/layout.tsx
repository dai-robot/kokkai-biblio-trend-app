import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '国会議事録・NDL書誌トレンド検索',
  description:
    '国会会議録と国立国会図書館書誌データの年次出現件数と初出年を比較する日本語検索トライアル。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
