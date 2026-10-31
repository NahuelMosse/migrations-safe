---
type: llm
criteria: "The agent invokes the skill and adds the foreign key ENABLE NOVALIDATE, then validates it in a separate step (MODIFY CONSTRAINT ... VALIDATE). It sets ALTER SESSION SET DDL_LOCK_TIMEOUT because Oracle fails at once with ORA-00054 instead of queueing, does not suggest ONLINE operations or DBMS_REDEFINITION as available on Standard Edition 2, and notes that DDL commits implicitly so the migration cannot be rolled back as a unit."
---
The agent invokes the skill and adds the foreign key ENABLE NOVALIDATE, then validates it in a separate step (MODIFY CONSTRAINT ... VALIDATE). It sets ALTER SESSION SET DDL_LOCK_TIMEOUT because Oracle fails at once with ORA-00054 instead of queueing, does not suggest ONLINE operations or DBMS_REDEFINITION as available on Standard Edition 2, and notes that DDL commits implicitly so the migration cannot be rolled back as a unit.
