import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import 'material-symbols/outlined.css';
import '@labelconsole/ui/styles.css';

export const metadata: Metadata = {
  title: { default: 'Label Console', template: '%s · Label Console' },
  description: 'One workspace for a record label: catalogue, roster, marketing, documents, files, streams and AI agents.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#FAFAF9' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
