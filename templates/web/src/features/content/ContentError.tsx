'use client';
import { useLocale } from 'next-intl';
export function ContentError({ reset }: { reset: () => void }) {
  const zh = useLocale() === 'zh';
  return (
    <section className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-3xl font-bold">
        {zh ? '内容暂时无法加载' : 'Content is temporarily unavailable'}
      </h1>
      <p className="mt-4 text-[var(--color-muted)]">
        {zh ? '请稍后重试。' : 'Please try again in a moment.'}
      </p>
      <button onClick={reset} className="mt-6 rounded-lg bg-primary-600 px-5 py-3 text-white">
        {zh ? '重试' : 'Try again'}
      </button>
    </section>
  );
}
