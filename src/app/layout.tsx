import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PoofSpace · 临时端到端加密聊天室',
  description: '免注册、多人、端到端加密的临时聊天室：创建即分享，无人即销毁。',
  robots: { index: false, follow: false },
  other: { 'referrer-policy': 'no-referrer' }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0a0a0a',
  colorScheme: 'dark'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
