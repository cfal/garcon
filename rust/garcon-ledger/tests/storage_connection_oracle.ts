import {
  closeConnection,
  openConnection,
} from '../../../server/controller/ledger/connection-setup.ts';
import { ensureLedgerRootDirectory } from '../../../server/controller/ledger/directories.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [root, chat, operation] = Bun.argv.slice(2);
if (operation === 'root-error') {
  try {
    console.log(JSON.stringify({ root: ensureLedgerRootDirectory(root!) }));
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message }));
  }
  process.exit(0);
}
const started = performance.now();
const retained = operation === 'measure' ? new Set(['retained']) : new Set<string>();
const entry = openConnection(root!, chat!, 'FULL', retained);
const openMs = performance.now() - started;

try {
  if (operation === 'measure') console.error(`Bun open with abandoned staging: ${openMs.toFixed(2)} ms`);
  console.log(JSON.stringify({
    schema: entry.db.query(`
      SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name
    `).all(),
    version: entry.db.query('PRAGMA user_version').get()?.user_version,
    journal: entry.db.query('PRAGMA journal_mode').get()?.journal_mode,
    synchronous: entry.db.query('PRAGMA synchronous').get()?.synchronous,
    foreignKeys: entry.db.query('PRAGMA foreign_keys').get()?.foreign_keys,
    busyTimeout: entry.db.query('PRAGMA busy_timeout').get()?.timeout,
    current: entry.current,
    nextOrdinal: entry.nextOrdinal,
  }));
} finally {
  const attempt = closeConnection(entry);
  if (!attempt.closed) throw attempt.failure;
}
