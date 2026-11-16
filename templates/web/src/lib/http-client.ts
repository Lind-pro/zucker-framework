import { clearLocalAuth, createAccountClient } from "./account-session";
import { DEFAULT_LOCALE, isLocale } from "./site/locales";
import { localizedPath } from "./site/url";

export { accountPublicClient } from "./account-session";

export const httpClient = createAccountClient(() => {
  clearLocalAuth();
  if (typeof window === "undefined") return;
  // The default locale is unprefixed (/login); the other one keeps its prefix (/zh/login).
  const segment = window.location.pathname.split("/")[1];
  const locale = isLocale(segment) ? segment : DEFAULT_LOCALE;
  const login = new URL(localizedPath(locale, "/login"), window.location.origin);
  login.searchParams.set("redirect", window.location.pathname + window.location.search);
  window.location.replace(login.href);
});
