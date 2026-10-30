---
name: required-column-big-table
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
---
Add a required `currency` column to `orders` (it has 40M rows, Postgres 15).
