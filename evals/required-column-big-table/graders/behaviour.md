---
type: llm
criteria: "The agent invokes the skill and adds the column nullable or with a constant default, backfills in batches outside the migration, then CHECK NOT VALID, VALIDATE, SET NOT NULL, with lock_timeout set. It does not use a fake default to pass, and reports the linter exit code per file."
---
The agent invokes the skill and adds the column nullable or with a constant default, backfills in batches outside the migration, then CHECK NOT VALID, VALIDATE, SET NOT NULL, with lock_timeout set. It does not use a fake default to pass, and reports the linter exit code per file.
