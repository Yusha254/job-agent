import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fieldnote | Job pipeline',
  description: 'A considered workspace for job applications.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}