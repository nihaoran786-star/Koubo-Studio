import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '口播神器 — AI 自媒体口播一站式生成',
  description:
    'AI 自媒体口播神器：一键生成标题文案、克隆声音、数字人形象、视频合成与多平台发布。极简、轻量、高科技。',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh" className="bg-background">
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
