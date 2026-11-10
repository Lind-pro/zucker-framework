import { redirect } from "@/i18n/navigation";

/** Keep old bookmarks useful until an application supplies its own business dashboard. */
export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/account", locale });
}
