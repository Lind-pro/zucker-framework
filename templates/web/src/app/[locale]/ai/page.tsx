import { redirect } from '@/i18n/navigation';

type Props = { params: Promise<{ locale: string }> };

/** `/ai` has no page of its own: open the image generator. */
export default async function Page({ params }: Props) {
  const { locale } = await params;
  redirect({ href: '/ai/image', locale });
}
