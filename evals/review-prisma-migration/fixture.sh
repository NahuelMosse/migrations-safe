#!/usr/bin/env bash
set -euo pipefail

mkdir -p prisma/migrations/20261029000000_init prisma/migrations/20261030000000_cleanup src
printf 'provider = "postgresql"\n' > prisma/migrations/migration_lock.toml
printf 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n' > prisma/schema.prisma
cat > prisma/migrations/20261029000000_init/migration.sql <<'SQL'
CREATE TABLE "orders" ("id" SERIAL PRIMARY KEY, "status" TEXT NOT NULL, "note" TEXT, "created_at" TIMESTAMP NOT NULL DEFAULT now());
SQL
cat > prisma/migrations/20261030000000_cleanup/migration.sql <<'SQL'
ALTER TABLE "orders" DROP COLUMN "note";
CREATE INDEX "orders_created_at_idx" ON "orders" ("created_at");
SQL
cat > src/orders.ts <<'TS'
export const orderLabel = (o: { id: number; note: string | null }) => `${o.id}: ${o.note ?? ''}`;
TS
