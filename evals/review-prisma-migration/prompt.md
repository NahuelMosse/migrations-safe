---
name: review-prisma-migration
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
Review this Prisma migration before I merge: prisma/migrations/20261030000000_cleanup/migration.sql.
