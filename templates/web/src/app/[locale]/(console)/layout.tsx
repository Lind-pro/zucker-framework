import type { Metadata } from 'next';
import { ConsoleSidebar } from '@/components/ConsoleSidebar';

/** Signed-in area: never indexed; the proxy marks these paths `private, no-store`. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-7xl gap-8 px-4 py-6 lg:flex lg:px-6">
      <aside className="mb-4 lg:mb-0 lg:w-56 lg:shrink-0">
        <ConsoleSidebar />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
