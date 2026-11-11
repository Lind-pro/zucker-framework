---
name: provider-setup
description: "Configure the external providers of a zucker create workspace: payments (Stripe, PayPal, Creem), AI connections and model pricing, account and notification mail (SMTP, Resend), Google and GitHub sign-in, S3 or R2 storage and site analytics, through the admin Connections page or the root .env, and test them with test modes or the local fakes. Use when the user wants to switch a provider on; never to call provider APIs."
---

# Provider setup

Every provider is off by default and the site works without any of them (pricing shows "not
purchasable", AI pages show the provider as unavailable). This skill explains where each setting
lives and prepares the change; the user supplies credentials and runs the real tests.

## Secrets: hard rules

- Never ask the user to paste a key, secret or password into the conversation, and never print,
  copy, log or commit `.env`. The user types secrets into the admin form or into `.env` themselves.
- You may add or edit **non-secret** `.env` keys (enable switches, modes, account scopes, model ids,
  hosts, ports, sender addresses) and leave secret keys present but empty for the user to fill.
- Never call a provider API, open a real checkout or send real mail to test. Use test modes and the
  local fakes below; real end-to-end tests are run by the user.
- Never set `NODE_ENV=production` together with a test fake.

## Two places to configure

1. **Admin, System settings, Connections** (`/connections`, needs `config:update`): values are stored
   encrypted with `CONFIG_ENCRYPTION_KEY` (keep that key stable; changing it makes saved
   settings unreadable). A saved field overrides the same `.env` key; unsaved fields keep the `.env`
   value. Every shipped connection applies without a restart: the next request (for payment, the
   next new order) uses it, while existing orders keep their own account's credentials. If a saved
   revision cannot be applied, the page shows it and the previous one keeps serving. Changing the
   private-storage location while files exist asks for confirmation (files are not moved). Prefer
   this for production credentials.
2. **Root `.env`**: read at server start (`pnpm dev` restarts the server on source changes only;
   restart it after editing `.env`). The authoritative list of keys with comments is
   `apps/server/.env.example`; the workspace `.env.example` shows the composed file.

Product rules that are not credentials are **Policies** (`/policies`): sign-up, email verification,
default payment channel, promo codes, AI catalogue and prices. They apply within about 30 seconds
without a restart; `POLICY_<POLICY>_<FIELD>` in `.env` pins a field (read-only in the admin).

## Payments

| Provider | Switches (non-secret) | Secrets (user fills) |
| --- | --- | --- |
| Stripe | `BILLING_STRIPE_ENABLED`, `BILLING_STRIPE_MODE=test`, `BILLING_STRIPE_ACCOUNT_SCOPE` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| PayPal | `BILLING_PAYPAL_ENABLED`, `BILLING_PAYPAL_MODE=sandbox`, `BILLING_PAYPAL_ACCOUNT_SCOPE`, `PAYPAL_WEBHOOK_ID` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` |
| Creem | `BILLING_CREEM_ENABLED`, `BILLING_CREEM_MODE=test`, `BILLING_CREEM_ACCOUNT_SCOPE` | `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET` |

- The account scope is a stable label of the provider account (for example `stripe-acme-test`);
  orders remember it, so do not reuse one label for different accounts.
- Webhook endpoint to register at the provider: the public URL that reaches the server's `/api`,
  normally `https://<site>/api/billing/webhooks/stripe` (or `paypal`, `creem`) through the web app.
  A local machine is not reachable from the provider; use the provider's own CLI forwarding if the
  user wants local webhooks.
- What is sold: plans in admin Commerce, Plans; credit packs in Credit packs. Each needs the
  provider's price/product reference (Stripe Price ID, Creem Product ID, PayPal SKU or Plan ID).
  `BILLING_CATALOG_JSON` only seeds plans and packs once during `pnpm setup:admin`. PayPal
  subscriptions need `subscriptionGrantBasis: {"paypal":"payment"}` in that catalogue.
- Local demo without any account: `BILLING_TEST_FAKE_PROVIDER=true` (refused in production) adds an
  in-memory `fake` provider with a test checkout page; give a plan or pack a `fake` reference.
  Its state is lost on restart.
- Verification order: buy in test mode, confirm via the return page and the webhook, check credits
  or the subscription once, then cancel and refund. A `success` URL alone never grants anything.

## AI

- Chat and images: one or more native connections, each `AI_<P>_ENABLED`, `AI_<P>_MODEL_ID`,
  optional `AI_<P>_BASE_URL`, `AI_<P>_MAX_TOKENS` (required for Anthropic), `AI_<P>_TIMEOUT_MS`,
  secret `AI_<P>_API_KEY`, for `<P>` in `OPENAI`, `COMPATIBLE`, `OPENROUTER`, `DEEPSEEK`,
  `ANTHROPIC`, `GEMINI`. Image generation uses the OpenAI connection by default.
- Video, music or other async media: `AI_MEDIA_ADAPTERS` (a JSON array describing submit and poll
  endpoints) with `AI_MEDIA_<ID>_API_KEY` and optional `AI_MEDIA_<ID>_CALLBACK_SECRET`. Invalid
  declarations stop the server at start-up. Callbacks go to `/api/ai/tasks/callbacks/<id>`.
- What users can pick and what it costs: admin AI, Models & pricing (policies `ai-catalog` and
  `ai-pricing`), hot-applied. Set prices before enabling a paid model.
- Local demo: `AI_TEST_FAKE_PROVIDERS=true` (refused in production) gives deterministic fake chat
  and media providers. Do not use real keys for automated tests.

## Mail

- Account mail (verification, reset, welcome, receipts): `MAIL_PROVIDER=smtp` with `SMTP_HOST`,
  `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, secret `SMTP_PASSWORD`; or
  `MAIL_PROVIDER=resend` with `SMTP_FROM` and secret `MAIL_RESEND_API_KEY`. `SITE_NAME` names the
  product in mail. Locally the generated `.env` points at Mailpit (http://localhost:8025).
- Job notifications are separate and off: `DELIVERY_PROVIDER=none|smtp|resend`,
  `DELIVERY_ACCOUNT_SCOPE`, `DELIVERY_FROM`, then `DELIVERY_SMTP_*` or `DELIVERY_RESEND_API_KEY`.
- Templates and the send log are in the admin under Operations (mail templates, mail logs).
- Without mail during development, the `account` policy field `requireEmailVerification` can be
  switched off in Policies.

## Sign-in, storage, analytics

- Google / GitHub: `GOOGLE_OAUTH_ENABLED`, `GOOGLE_ONE_TAP_ENABLED`, `GOOGLE_CLIENT_ID`,
  secret `GOOGLE_CLIENT_SECRET`; `GITHUB_OAUTH_ENABLED`, `GITHUB_CLIENT_ID`, secret
  `GITHUB_CLIENT_SECRET`. Callback URLs to register: `<WEB_URL>/api/authorize/oauth/google/callback`
  and `.../github/callback`.
- Files: the workspace uses MinIO locally (`FILES_STORAGE_PROVIDER=s3`, `FILES_S3_*`). For R2 or
  another S3 service set bucket, region, endpoint and the key pair; keep the bucket private. Changing
  the bucket or endpoint when files exist strands those files: plan a copy first.
- Analytics, ads and support widgets: Connections, public website profiles; all off by default and
  the product owns consent.

## Verify

After each change: restart the server if needed, run `pnpm doctor`, check
`http://localhost:4200/api/health/ready`, then walk the user flow in test mode (pricing page lists
the plan, AI page lists the model, sign-up mail arrives in Mailpit). Report exactly which flows you
verified and which the user must verify with real accounts.
