import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ticketFixture, caller } from './fixture.js';
import { TicketStore, configureTicketDatabase } from '../store.js';

let fixture;
beforeEach(() => { fixture = ticketFixture(); });
afterEach(() => { fixture.cleanup(); });

test('creates only the ticket database and ticket-owned schema', () => {
  expect(existsSync(join(fixture.directory, 'tickets.sqlite'))).toBe(true);
  expect(existsSync(join(fixture.directory, 'issues.sqlite'))).toBe(false);
  const names = fixture.store.read((database) => database.query(
    "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
  ).all().map((row) => row.name));
  expect(names).toContain('tickets');
  expect(names).toContain('ticket_operations');
  expect(names.every((name) => name.startsWith('ticket'))).toBe(true);
});

test('verifies requested durability settings and refuses a VFS that cannot provide WAL', () => {
  fixture.store.read((database) => {
    expect(database.query('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(database.query('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(database.query('PRAGMA synchronous').get().synchronous).toBe(2);
  });
  const memory = new Database(':memory:');
  try { expect(() => configureTicketDatabase(memory)).toThrow('Unsupported ticket durability configuration'); }
  finally { memory.close(); }
});

test.each([0, 1])('does not alter the journal or contents of an unrecognized SQLite database at version %s', (version) => {
  const directory = join(fixture.directory, 'foreign');
  mkdirSync(directory);
  const path = join(directory, 'tickets.sqlite');
  const original = new Database(path);
  original.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('Synthetic data');");
  original.exec(`PRAGMA user_version=${version}`);
  original.close();
  expect(() => new TicketStore(directory)).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
  const reopened = new Database(path);
  try {
    expect(reopened.query('PRAGMA journal_mode').get().journal_mode).toBe('delete');
    expect(reopened.query('PRAGMA user_version').get().user_version).toBe(version);
    expect(reopened.query('SELECT value FROM unrelated').get().value).toBe('Synthetic data');
  } finally { reopened.close(); }
});

test('fences a regular-file replacement between SQLite open and pathname validation before journal changes', () => {
  const directory = join(fixture.directory, 'replacement');
  mkdirSync(directory);
  const path = join(directory, 'tickets.sqlite');
  const replacedPath = join(directory, 'original.sqlite');
  expect(() => new TicketStore(directory, { afterDatabaseOpen() {
    renameSync(path, replacedPath);
    const replacement = new Database(path);
    replacement.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('Synthetic replacement');");
    replacement.close();
  } })).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
  for (const candidate of [path, replacedPath]) {
    const database = new Database(candidate);
    try {
      expect(database.query('PRAGMA journal_mode').get().journal_mode).toBe('delete');
      expect(database.query("SELECT count(*) AS count FROM sqlite_schema WHERE name='ticket_meta'").get().count).toBe(0);
    } finally { database.close(); }
  }
});

test('rejects an incomplete ticket schema and invalid sentinel before persistent journal conversion', () => {
  for (const fault of ['schema', 'sentinel']) {
    const directory = join(fixture.directory, fault);
    mkdirSync(directory);
    new TicketStore(directory).close();
    const path = join(directory, 'tickets.sqlite');
    const damaged = new Database(path);
    damaged.exec('PRAGMA journal_mode=DELETE');
    damaged.exec(fault === 'schema' ? 'DROP TABLE ticket_activity' : "UPDATE ticket_meta SET store_id='invalid'");
    damaged.close();
    expect(() => new TicketStore(directory)).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
    const reopened = new Database(path);
    try { expect(reopened.query('PRAGMA journal_mode').get().journal_mode).toBe('delete'); }
    finally { reopened.close(); }
  }
});

test.each(['missing', 'extra'])('fences a %s normalized label without repairing canonical records', (kind) => {
  const first = fixture.create({ labels: ['Canonical'] });
  fixture.store.read((database) => {
    if (kind === 'missing') database.query('DELETE FROM ticket_labels WHERE ticket_number=?').run(first.ticket.number);
    else database.query('INSERT INTO ticket_labels VALUES (?,?)').run(first.ticket.number, 'Unexpected');
  });
  fixture.service.close();
  expect(() => new TicketStore(fixture.directory)).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
});

test('continues monotonically allocated ticket numbers after closing and reopening', () => {
  const first = fixture.create().ticket;
  fixture.write({ action: 'close', ticketId: first.id, expectedRevision: first.revision });
  fixture.reopen();
  expect(fixture.create().ticket.number).toBe(first.number + 1);
});

test('reopen preserves immutable identity and creates or repairs private file modes', () => {
  const initial = fixture.service.bootstrap(caller.authority);
  fixture.create();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = join(fixture.directory, `tickets.sqlite${suffix}`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o666);
  }
  const repair = new TicketStore(fixture.directory);
  for (const suffix of ['', '-wal', '-shm']) expect(statSync(join(fixture.directory, `tickets.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
  repair.close();
  fixture.reopen();
  expect(fixture.service.bootstrap(caller.authority)).toEqual({ ...initial, collectionRevision: 1 });
  for (const suffix of ['', '-wal', '-shm']) expect(statSync(join(fixture.directory, `tickets.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
});

test('a permissive umask in an isolated process cannot expose SQLite sidecars', async () => {
  fixture.service.close();
  const childDir = join(fixture.directory, 'permissive');
  mkdirSync(childDir, { mode: 0o777 });
  const processHandle = Bun.spawn([process.execPath, '-e', `
    import { TicketStore } from ${JSON.stringify(new URL('../store.ts', import.meta.url).pathname)};
    import { statSync } from 'node:fs';
    import { join } from 'node:path';
    process.umask(0);
    const store = new TicketStore(process.argv[1]);
    for (const suffix of ['', '-wal', '-shm']) {
      if ((statSync(join(process.argv[1], 'tickets.sqlite' + suffix)).mode & 0o777) !== 0o600) process.exit(1);
    }
    store.close();
  `, childDir], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(processHandle.stderr).text();
  expect(await processHandle.exited).toBe(0);
  expect(stderr).toBe('');
});

test('rejects symlinked or nonregular databases and sidecars', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const directory = join(fixture.directory, `case${suffix || '-main'}`);
    mkdirSync(directory);
    symlinkSync(join(fixture.directory, 'tickets.sqlite'), join(directory, `tickets.sqlite${suffix}`));
    expect(() => new TicketStore(directory)).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
  }
  const directory = join(fixture.directory, 'nonregular');
  mkdirSync(directory);
  mkdirSync(join(directory, 'tickets.sqlite'));
  expect(() => new TicketStore(directory)).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
});

test('rolls back domain, history, and retry record together and fences unknown commit failures', () => {
  const first = fixture.create();
  const request = fixture.request({ action: 'close', ticketId: first.ticket.id, expectedRevision: 1, comment: 'Atomic close.' });
  fixture.controls.failCommit = true;
  expect(() => fixture.service.executeHttp(request, caller)).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
  expect(() => fixture.service.list({})).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
  expect(fixture.invalidations).toEqual([1]);
  fixture.reopen();
  expect(fixture.service.read({ ticketId: first.ticket.id }, caller.authority).ticket).toEqual(first.ticket);
  expect(fixture.service.comments({ ticketId: first.ticket.id }, caller.authority).items).toHaveLength(0);
  expect(fixture.service.history({ ticketId: first.ticket.id }).items).toHaveLength(1);
  const retried = fixture.service.executeHttp(request, caller);
  expect(retried.ticket.status).toBe('closed');
  expect(fixture.service.history({ ticketId: first.ticket.id }).items).toHaveLength(3);
});

test('rejects unknown schema and inconsistent normalized records without rebuilding', () => {
  const first = fixture.create();
  fixture.store.read((database) => database.query("UPDATE tickets SET status='in-progress' WHERE number=?").run(first.ticket.number));
  expect(() => fixture.service.list({})).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
  const database = new Database(join(fixture.directory, 'tickets.sqlite'));
  database.exec('PRAGMA user_version=99');
  database.close();
  expect(() => new TicketStore(fixture.directory)).toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
});

test('counter exhaustion rejects before partial effects', () => {
  const first = fixture.create();
  fixture.store.read((database) => database.query('UPDATE ticket_meta SET revision=?').run(Number.MAX_SAFE_INTEGER - 1));
  expect(() => fixture.write({ action: 'comment', ticketId: first.ticket.id, body: 'Must roll back.' }))
    .toThrow(expect.objectContaining({ code: 'TICKET_LIMIT_REACHED' }));
  expect(fixture.service.comments({ ticketId: first.ticket.id }, caller.authority).items).toHaveLength(0);
  expect(fixture.service.history({ ticketId: first.ticket.id }).items).toHaveLength(1);
});

test('asynchronous transaction callbacks are rejected and cannot commit an unawaited mutation', () => {
  expect(() => fixture.store.transaction(() => Promise.resolve('invalid')))
    .toThrow(expect.objectContaining({ code: 'TICKET_STORAGE_UNAVAILABLE' }));
  fixture.reopen();
  expect(fixture.service.list({}).items).toEqual([]);
});
