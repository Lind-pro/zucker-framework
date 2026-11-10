import { Suspense } from 'react';
import type { Metadata } from 'next';
import { privatePageMetadata } from '@/features/ai/metadata';
import ChatPage from '@/features/chat/ChatPage';
import { chatCopy } from '@/features/chat/copy';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return privatePageMetadata(locale, '/chat', chatCopy(locale).title);
}

/** The selected conversation lives in `?c=`; useSearchParams needs a Suspense boundary. */
export default function Page() {
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
