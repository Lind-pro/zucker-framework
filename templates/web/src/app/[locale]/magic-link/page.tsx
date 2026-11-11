import { Suspense } from "react";
import { MagicLinkPage } from "@/features/account-security/MagicLinkPage";

/** The return path lives in `?redirect=`; useSearchParams needs a Suspense boundary. */
export default function Page() {
  return <Suspense><MagicLinkPage /></Suspense>;
}
