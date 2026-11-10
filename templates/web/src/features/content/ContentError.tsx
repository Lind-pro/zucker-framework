'use client';
import { useLocale } from 'next-intl';
import { contentCopy } from './copy';
export function ContentError({ reset }: { reset: () => void }) {
  const copy = contentCopy(useLocale());
  return (
    <section className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-3xl font-bold">{copy.unavailableTitle}</h1>
      <p className="mt-4 text-[var(--color-muted)]">{copy.unavailableText}</p>
      <button onClick={reset} className="mt-6 rounded-lg bg-primary-600 px-5 py-3 text-white">
        {copy.retry}
      </button>
    </section>
  );
}
