import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ImajinAuthStatus } from '@/components/ImajinAuthStatus';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Imajin Events',
  description: 'Events and ticketing — a third-party app on Imajin, forked from ima-jin/imajin-app-template.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <Providers>
          <header className="flex items-center justify-between border-b border-gray-800/50 bg-gray-950/90 px-4 py-2 backdrop-blur">
            <nav aria-label="Main navigation" className="flex gap-4 text-sm text-white">
              <Link href="/" className="font-semibold">Imajin Events</Link>
              <Link href="/dashboard">My Events</Link>
            </nav>
            <ImajinAuthStatus />
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
