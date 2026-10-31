// One engine per run; each module returns the docker exec prefix, the SQL its lock poller runs and the
// queries that read the schema back.
import { makeMysql } from './mysql.mjs';
import { makePostgres } from './postgres.mjs';

export { mysqlInput } from './mysql.mjs';

export const makeEngine = (spec) => (spec.kind === 'postgres' ? makePostgres(spec) : makeMysql(spec));
