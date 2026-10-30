---
name: rename-column
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
Rename `users.fullname` to `display_name`. Write the migration.
