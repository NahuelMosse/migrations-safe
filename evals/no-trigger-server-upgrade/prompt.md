---
name: no-trigger-server-upgrade
tags: [trigger, negative]
runs: 3
max_turns: 5
timeout_seconds: 120
allowed_tools: [Read, Glob, Grep, Skill]
---
Upgrade our Postgres server from 13 to 16.
