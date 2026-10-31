---
name: mssql-required-column-standard
tags: [trigger]
runs: 3
max_turns: 10
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
Add a required `currency` column with default 'USD' to `dbo.Orders` (60M rows, SQL Server 2022 Standard edition). Write the migration.
