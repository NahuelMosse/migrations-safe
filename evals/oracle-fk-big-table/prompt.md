---
name: oracle-fk-big-table
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
Add a foreign key from `orders.customer_id` to `customers(id)` on an Oracle 19c Standard Edition 2 database. `orders` has 80M rows and takes writes all day. Write the migration.
