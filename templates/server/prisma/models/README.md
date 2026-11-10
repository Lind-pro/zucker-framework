# Feature schema fragments

`prisma.config.ts` points Prisma at the `prisma/` directory, so every `*.prisma` file here is merged
with `../schema.prisma` (which keeps the generator and datasource blocks) for `prisma generate`,
`prisma validate` and `prisma migrate`.

Conventions:

- One file per feature: `models/<feature>.prisma`, plus one migration directory
  `../migrations/<timestamp>_<feature>/migration.sql` written for it.
- Reference users and other tables by scalar id (`userId String`); do not add relation fields that
  cross into another file. This matches the existing schema style and keeps fragments independent.
- Do not declare `generator` or `datasource` blocks here.
- Schema drift checks must diff against the directory (`--to-schema prisma`), not `schema.prisma` alone.
