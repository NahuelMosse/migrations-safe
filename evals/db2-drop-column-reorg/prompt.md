---
name: db2-drop-column-reorg
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
The `legacy_code` column of `orders` (Db2 11.5 LUW, 30M rows) has not been read by any release for two months. Write the migration that drops it.
