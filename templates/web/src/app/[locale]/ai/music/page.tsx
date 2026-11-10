import type { Metadata } from 'next';
import { aiCopy } from '@/features/ai/copy';
import GeneratorPage from '@/features/ai/GeneratorPage';
import { privatePageMetadata } from '@/features/ai/metadata';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const copy = aiCopy(locale);
  return privatePageMetadata(locale, '/ai/music', copy.titles.audio, copy.descriptions.audio);
}

export default function Page() {
  return <GeneratorPage kind="audio" />;
}
