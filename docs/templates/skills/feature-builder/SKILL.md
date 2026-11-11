---
name: feature-builder
description: "Add a product feature to a zucker create workspace following the starter's conventions: feature folder in apps/server/src with module, controller, service, validation and policy, a Prisma model fragment plus migration, permissions and admin menu, an admin page, a web console page and tests. Use when the user asks for new business functionality; not for copy, branding or provider credentials."
---

# Feature builder

The starter already contains complete features built the same way (`feedback`, `promotions`,
`referrals`, `inbox`, `ai-tasks`, `chat`). Read the closest one end to end before writing code and
copy its structure, not its domain. Also read the project `AGENTS.md`: reuse installed
`@zucker-framework/*` exports before writing a generic mechanism, keep product rules in the app.

## 0. Plan before code

Write down, and confirm with the user when it is not obvious:

- the resource, who owns it (user id) and who may read/write it (owner, staff permission codes);
- inputs and their exact limits; what is idempotent (an `Idempotency-Key` header on creates);
- whether it costs credits or uses AI (reuse the existing services, never a new provider client);
- background work (only through the existing jobs host) and notifications (inbox, mail);
- which apps change: server only, plus admin page, plus web console page.

## 1. Server feature folder

`apps/server/src/<feature>/`, kebab-case names, an `index.ts` that exports the public surface:

| File | Contents |
| --- | --- |
| `<feature>.validation.ts` | Parse `unknown` bodies with exact-key checks and bounded lengths; throw `BadRequestException`. |
| `<feature>.service.ts` | `@Injectable()`; SQL through the injected `DATABASE_ADAPTER` (`ApplicationDatabase`), writes inside `database.transaction(tx => ...)`, owner id in every `WHERE`. |
| `<feature>.controller.ts` | Owner routes under `/<feature>`, staff routes under `/management/<feature>`. |
| `<feature>.policy.ts` | Optional switches and limits with `definePolicy` (`../policy/policy.registry`); admin edits them under Policies, `POLICY_<ID>_<FIELD>` env pins them. |
| `<feature>.module.ts` | `@Module({ controllers, providers, exports })`. |

Controller rules (see `feedback/feedback.controller.ts`):

- `@Permissions()` on owner controllers (any signed-in user), `@Permissions('<feature>:query')` /
  `'<feature>:update'` on staff routes. Pass codes as separate strings, never an array.
- `@UseGuards(RateLimitGuard)` with `@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })`,
  plus a feature limiter exported as `<FEATURE>_RATE_LIMITERS: RateLimiterFragment` for costly writes.
- Every write calls `assertTrustedOrigin(this.origins, req)` (from `../ai-tasks/ai-tasks.controller`).
- `@Body() body: unknown`, validated in the service; `@Header('Cache-Control', 'private, no-store')`
  on user data. Return plain values the way the existing controllers do; the web `httpClient` already handles the response shape.
- Return 404 (not 403) when a user asks for someone else's row.

Background work: register a handler on the existing jobs service (`jobs.registerHandler`,
`jobs.registerWakeSource`; examples in `jobs/jobs.handlers.ts` and `referrals/referral-rewards.ts`).
No `setInterval`, no second worker. Credits: hold, confirm and release through the credits services
the way `ai-tasks` does; never update balances directly.

## 2. Data

- New file `apps/server/prisma/models/<feature>.prisma` (see `prisma/models/README.md`): reference
  users by scalar `userId String`, no relation fields into other files, `@@map("<table>")`, indexes
  for the list queries you write. Do not edit `schema.prisma`.
- Create the migration against the local development database only:

  ```bash
  node scripts/with-env.mjs pnpm --filter ./apps/server exec prisma migrate dev --create-only --name <feature>
  ```

  Review the SQL, add CHECK constraints the model cannot express, then apply it with `pnpm db:migrate`.
  Never edit an applied migration, never `db push`, never point this at a shared or production database.

## 3. Wire it in (composition files)

- `apps/server/src/app.module.ts`: import the module; append `...<FEATURE>_POLICIES` to
  `PolicyModule.forRoot({ policies })`; append `<FEATURE>_RATE_LIMITERS` to `composeRateLimiters(...)`.
- Permissions and menu: add the codes to `BACK_OFFICE_PERMISSIONS` in
  `src/accounts/create-administrator.ts` and a menu entry in `src/accounts/starter-admin-menus.ts`
  (seeded by `setup:admin` on new databases). For a database that is already set up, add the same
  rows idempotently in the feature migration (`INSERT ... ON CONFLICT DO NOTHING`), following
  `prisma/migrations/*_phase3_integration/migration.sql`. Grant write codes to roles explicitly.
- Account deletion: if rows hold personal data, add a deletion contributor like
  `feedback/feedback.deletion.ts` and register it in `src/accounts/deletion/app-contributors.ts`.

## 4. Admin page (`apps/admin`)

`src/features/<feature>/index.ts` exports `<feature>Pages: AdminPageDefinition[]` (`key`, `path`
matching the menu path, `title` in `zh-CN` and `en-US`, `permission`, `component`, `icon` from
`lucide-react`); register it with one spread in `src/features/index.ts`. Never edit `admin.tsx` for a
feature. Disable write controls when the user lacks the write permission.

## 5. Web console page (`apps/web`)

- Data access in `src/features/<feature>/api.ts` with `httpClient` from `@/lib/http-client`
  (browser calls `/api/...`); UI in `src/features/<feature>/`; copy in both locales.
- Route: `src/app/[locale]/(console)/<path>/page.tsx` re-exporting the feature page.
- Navigation: `src/features/<feature>/console-nav.ts` exporting `ConsoleNavItem[]`, spread into
  `src/lib/site/console-nav.ts`. Public pages also go into `src/lib/site/sitemap-routes.ts`.

## 6. Verify

Run the smallest checks first, then the affected apps:

```bash
pnpm --filter ./apps/server lint
pnpm --filter ./apps/server build
pnpm --filter ./apps/admin lint && pnpm --filter ./apps/admin build
pnpm --filter ./apps/web lint && pnpm --filter ./apps/web test
```

Add tests next to the existing ones (`apps/server/test/*.e2e-spec.ts` use a disposable database and
synthetic data; copy the setup of a similar spec). Cover: validation rejects unknown keys and limits,
another user gets 404, a viewer without the permission gets 403, a replayed `Idempotency-Key` does
not create a second row. Then run the app with `pnpm dev` and use the feature in the browser.
Report what you did not verify. Commits, pushes and deployments happen only when the user asks.
