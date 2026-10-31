---
type: llm
criteria: "The agent invokes the skill and treats DROP COLUMN as a contract step needing a backup and a recorded approval. It knows Db2 LUW leaves the table REORG-pending after it (SQLSTATE 57007 until a classic offline REORG TABLE), puts CALL SYSPROC.ADMIN_CMD('REORG TABLE orders') right after it, plans a window for the offline REORG sized from a rehearsal, sets CURRENT LOCK TIMEOUT, and mentions the limit of three such units of work before a REORG."
---
The agent invokes the skill and treats DROP COLUMN as a contract step needing a backup and a recorded approval. It knows Db2 LUW leaves the table REORG-pending after it (SQLSTATE 57007 until a classic offline REORG TABLE), puts CALL SYSPROC.ADMIN_CMD('REORG TABLE orders') right after it, plans a window for the offline REORG sized from a rehearsal, sets CURRENT LOCK TIMEOUT, and mentions the limit of three such units of work before a REORG.
