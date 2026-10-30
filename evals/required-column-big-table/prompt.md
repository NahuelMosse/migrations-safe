---
name: required-column-big-table
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
Add a required `currency` column to `orders` (it has 40M rows, Postgres 15).
