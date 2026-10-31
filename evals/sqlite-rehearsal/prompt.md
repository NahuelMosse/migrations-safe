---
name: sqlite-rehearsal
tags: [trigger]
runs: 3
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
Make sure the SQLite migration db/migrations/0007_tasks_cleanup.sql won't break the existing data before we ship the app update. db/seed.sql has realistic data.
