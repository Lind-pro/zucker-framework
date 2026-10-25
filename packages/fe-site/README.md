# @zucker-framework/fe-site

Optional advertising, referral and support connections for public website pages. This browser-safe,
zero-runtime-dependency package owns public connection configuration, once-per-document loading,
AdSense seller declarations and controlled referral-ID exchange. Analytics remains in
`@zucker-framework/fe-analytics`; this package does not own CMS content, accounts, prices, consent
policy, customer identification or payment fulfillment.

The source version follows the workspace's `1.0.8` baseline. This is a **new, unpublished package**;
the local Web integration is not evidence that an existing registry version contains it. Distribute
a new immutable artifact and verify the consumer before production use.

## Public connections

`resolveSiteConnections(config)` is pure: it returns independent connections and configuration
issues without reading cookies, creating globals or making requests. Both `config.enabled` and
each provider's `enabled` must be exactly `true`. A malformed enabled provider is omitted with an
issue; it does not prevent valid independent connections from being resolved.

| Configuration | Public protocol |
| --- | --- |
| `adsense: { enabled, publisherId }` | `ca-pub-` plus 16 digits; fixed Google AdSense script origin and anonymous cross-origin loading. Auto-ad eligibility/placement remains in the AdSense dashboard; no page ad slots are invented. |
| `affonso: { enabled, programId, cookieDurationDays }` | Official hosted pixel, `data-affonso` public program ID and explicit 1–365-day `data-cookie_duration`. |
| `promoteKit: { enabled, programId }` | Official PromoteKit script with `data-promotekit` public program ID. |
| `crisp: { enabled, websiteId }` | Website UUID, `$crisp` queue and fixed Crisp loader. No email/name/token identification. |
| `tawk: { enabled, propertyId, widgetId }` | Public property/widget identifiers, `Tawk_API` initialization and fixed tawk.to embed origin. No visitor metadata or login. |

`mountSiteConnections(config, { document, nonce?, onIssue? })` explicitly installs the resolved
scripts in the document head. Imports remain safe on the server. Bootstrap execution precedes each
external loader. Every provider is claimed once per `Document`, including failed loads and scripts
later removed by a host. Remounts do not retry. A changed configuration or conflicting existing DOM
ID produces an issue and requires a fresh page load. The returned `mounted` list means DOM insertion,
not provider readiness or successful network execution. Async script errors invoke `onIssue`.

The application checks route eligibility and any required consent before mounting. It can supply
a CSP nonce. Removing a script cannot undo an executed SDK or its timers. Enter account pages in a
fresh document; do the same when disabling/changing an already mounted connection. The Web template
uses the existing `isAccountPath` guard and `AccountLink` full-document navigation for this boundary.
No account form automatically loads these providers or reports personal data.

`buildAdsTxt(config)` returns one public Google seller declaration only when the global switch,
AdSense switch and publisher ID are valid; otherwise it returns `null`. The Web template exposes
this at **`/ads.txt`**, independent of locale, as plain text with status 200 or 404. Other ad networks
and seller policies remain consumer-owned.

## Controlled referral exchange

Affonso and PromoteKit create internal referral IDs. Read their official `affonso_referral` or
`promotekit_referral` cookie/global, not raw `atp`, `via` or `ref` URL parameters.

```ts
import { readReferral, referralMetadata } from '@zucker-framework/fe-site';

// Server: choose a configured and supported vendor for this payment provider.
const policy = { enabledProviders: ['affonso'] as const };
const referral = readReferral('affonso', { cookieHeader: request.headers.cookie }, policy);
const providerMetadata = referralMetadata(referral, policy);

// Actual payment-package input: independently frozen public metadata.
await checkout.create({
  orderId: persistedServerOrderId,
  ownerId: authenticatedUserId,
  offerId: selectedServerCatalogOffer,
  providerId: 'creem',
  providerMetadata,
});
```

`checkout` above is the consumer-configured `HostedCheckoutService` from `@zucker-framework/payment`.
The server owns the order ID, authenticated user and catalog lookup. The payment workflow freezes
`providerMetadata` on initial creation and its Stripe/Creem adapters forward it separately from the
order reference. Its private `offer.fulfillmentData` is never sent to providers. Repeated creation
preserves the original attribution instead of accepting a changed browser value.

The relevant APIs are:

- `readReferral(provider, { cookieHeader?, globals? }, policy)` reads only the selected official key.
- `readBrowserReferral(provider, policy)` explicitly reads the current document's cookies/globals;
  it neither loads a script nor performs a request or write. It can be used on an account page
  without mounting the third-party SDK there. Blocked cookie access does not crash the page.
- `validateReferral(input, policy)` returns a new `{ provider, referralId }` object or `null`.
- `referralMetadata(input, policy)` revalidates input and returns only `affonso_referral` or
  `promotekit_referral`, or `{}`. It never spreads arbitrary browser fields into payment metadata.

`policy.enabledProviders` is explicit and defaults to none. IDs are 1–128 characters, start with
an ASCII letter/digit and otherwise permit letters/digits, `_`, `-`, `.`, `~`. No coercion occurs.
Duplicate matching cookies, invalid encodings, invalid IDs and conflicting cookie/global values
are rejected. Cookie values are decoded once. Email/name/custom fields are not emitted. Browser
cookies are still untrusted attribution hints: these checks do not authenticate a referral, prove
a sale or authorize discounts, credits, trials or access. Revalidate at the billing boundary.

| Affiliate vendor | Stripe Checkout | Creem Checkout | PayPal Orders |
| --- | --- | --- | --- |
| Affonso | Official `metadata.affonso_referral` | Official `metadata.affonso_referral` | No native metadata protocol in this integration |
| PromoteKit | Official `metadata.promotekit_referral` | Not established | Not established |

Provider-account connections, webhook configuration and actual commission attribution remain in
the vendor's setup. Merely accepting an arbitrary metadata record does not establish affiliate
support. PayPal's hosted adapter explicitly rejects nonempty metadata; it does not hide it in
`custom_id`. Affonso's separate custom backend conversion API would require a further verified
payment-to-conversion integration and is not implemented here. Cross-domain cookie transfer is
also not automatic; this template's public/account boundary stays within the same origin.

## Verification and protocol sources

Run focused synthetic checks from the repository root:

```sh
node node_modules/vitest/vitest.mjs run packages/fe-site
node node_modules/typescript/bin/tsc -p packages/fe-site/tsconfig.json --noEmit
node --test templates/web/site-connections-config.test.mjs
node --test packages/fe-site/test/web-connections.browser.mjs
```

The browser contract starts an isolated copy of the real Web template with existing local
dependencies, intercepts every external request and supplies synthetic SDK responses. It verifies
default-off behavior, public-page loading, document-level deduplication, account-page exclusion,
same-origin referral preservation/readback and the real `/ads.txt` endpoint. It does not prove
provider availability, live commissions, advertising delivery or published artifact installation.
Set `CHROMIUM_EXECUTABLE` when a local Chrome/Chromium executable is not at the detected location.

Protocol references checked 2026-10-24:

- Google [AdSense script](https://support.google.com/adsense/answer/9274516?hl=en) and [ads.txt](https://support.google.com/adsense/answer/12171612?hl=en).
- Affonso [tracking script/ID](https://affonso.io/help/installation-guides/overview/how-affiliate-tracking-works), [Stripe metadata](https://affonso.io/help/tracking-settings/debug-stripe-tracking), and [Creem metadata](https://affonso.io/help/integrations/creem/creem-checkout-api).
- PromoteKit [affiliate links](https://www.promotekit.com/docs/affiliate-links) and [Stripe metadata](https://www.promotekit.com/docs/affiliate-links/stripe-api). Its official hosted script confirms the `data-promotekit` attribute and `promotekit_referral` identifier; no provider implementation is bundled.
- Crisp [standard embed](https://help.crisp.chat/en/article/how-to-troubleshoot-invalid-website-errors-in-the-chatbox-8j93zr/).
- tawk.to [embed setup](https://help.tawk.to/article/delaying-the-tawkto-widget-using-javascript) and [JavaScript API](https://developer.tawk.to/jsapi/).

## Versioned site documents

`@zucker-framework/fe-site/content` is a separate, pure entry point. `validateSiteDocument` accepts
version 1 documents with title/description/author, Markdown, SEO fields and ordered `hero`,
`markdown`, `features`, `faq`, `cta` and `links` blocks. It rejects unknown fields, unsafe action
URLs, duplicate block IDs, non-JSON objects and payloads exceeding 64 KiB UTF-8. There is no dynamic
component loading, executable MDX, database access or browser mount in this entry point.

`visibleSiteDocument` creates an independent publication snapshot and removes disabled blocks.
`siteDocumentText` omits those blocks from a consumer's persisted search text. Consumers retain
ownership of revisions, authorship, access control, language/slug policy, publication timing,
search and rendering. `resolveSiteTheme` resolves only names from an explicit consumer registry,
with a required registered fallback; `resolveSiteColorMode` supports light/dark/system.

The Web/Server templates demonstrate a real database-backed consumer. This package supplies the
shared document contract, not a universal CMS database or permission model. Focused contract tests:
`pnpm exec vitest run packages/fe-site/src/content.spec.ts`.
