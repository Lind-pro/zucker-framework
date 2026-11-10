import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  // Multi-file schema: `prisma/schema.prisma` (generator, datasource, existing models) plus every
  // `prisma/**/*.prisma` fragment, e.g. `prisma/models/<feature>.prisma`. Verified with Prisma 7.10
  // (`validate`, `generate`, `migrate diff --to-schema prisma`). Keep `schema.prisma` in place: the
  // CLI template bundle requires it.
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
