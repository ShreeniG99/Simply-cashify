import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Simply Cashify',
  description:
    'AI Finance Controller — multi-source cash reconciliation with measured accuracy and an honest exception list',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Instrument+Serif&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-bg text-text-primary">{children}</body>
    </html>
  )
}
