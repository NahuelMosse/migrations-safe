---
name: no-trigger-query-tuning
tags: [trigger, negative]
runs: 3
max_turns: 5
timeout_seconds: 120
allowed_tools: [Read, Glob, Grep, Skill]
---
This SELECT on orders takes 4 seconds, which index should I add?
