-- migration-lint: allow-file drop-column -- the column stopped being read in release 41 and a backup was verified (PLAT-214)
-- migration-lint: allow-file db2-reorg-offline -- a classic REORG is the only way out of REORG-pending; run in the Sunday window, 40 s on the copy (PLAT-214)
SET CURRENT LOCK TIMEOUT 5;
ALTER TABLE tickets DROP COLUMN legacy_code;
CALL SYSPROC.ADMIN_CMD('REORG TABLE tickets');
