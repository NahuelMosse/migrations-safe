---
name: review-prisma-migration
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
---
Review this Prisma migration before I merge: prisma/migrations/20261030_cleanup/migration.sql drops a column and creates an index on an existing table.
