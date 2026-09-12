import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { issueFixture, caller } from './fixture.js';
import { IssueStore, configureIssueDatabase } from '../store.js';

let fixture;
beforeEach(() => { fixture = issueFixture(); });
afterEach(() => { fixture.cleanup(); });

test('verifies requested durability settings and refuses a VFS that cannot provide WAL', () => {
  fixture.store.read((database) => {
    expect(database.query('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(database.query('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    expect(database.query('PRAGMA synchronous').get().synchronous).toBe(2);
  });
  const memory = new Database(':memory:');
  try { expect(() => configureIssueDatabase(memory)).toThrow('Unsupported issue durability configuration'); }
  finally { memory.close(); }
});

test('does not alter the journal or contents of an unrecognized SQLite database', () => {
  const directory = join(fixture.directory, 'foreign');
  mkdirSync(directory);
  const path = join(directory, 'issues.sqlite');
  const original = new Database(path);
  original.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('Synthetic data');");
  original.close();
  expect(() => new IssueStore(directory)).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
  const reopened = new Database(path);
  try {
    expect(reopened.query('PRAGMA journal_mode').get().journal_mode).toBe('delete');
    expect(reopened.query('PRAGMA user_version').get().user_version).toBe(0);
    expect(reopened.query('SELECT value FROM unrelated').get().value).toBe('Synthetic data');
  } finally { reopened.close(); }
});

test.each(['missing', 'extra'])('fences a %s normalized label without repairing canonical records', (kind) => {
  const first = fixture.create({ labels: ['Canonical'] });
  fixture.store.read((database) => {
    if (kind === 'missing') database.query('DELETE FROM issue_labels WHERE issue_number=?').run(first.issue.number);
    else database.query('INSERT INTO issue_labels VALUES (?,?)').run(first.issue.number, 'Unexpected');
  });
  fixture.service.close();
  expect(() => new IssueStore(fixture.directory)).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
});

test('continues monotonically allocated issue numbers after closing and reopening', () => {
  const first = fixture.create().issue;
  fixture.write({ action: 'close', issueId: first.id, expectedRevision: first.revision });
  fixture.reopen();
  expect(fixture.create().issue.number).toBe(first.number + 1);
});

test('reopen preserves immutable identity and creates or repairs private file modes', () => {
  const initial = fixture.service.bootstrap(caller.authority);
  fixture.create();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = join(fixture.directory, `issues.sqlite${suffix}`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o666);
  }
  const repair = new IssueStore(fixture.directory);
  for (const suffix of ['', '-wal', '-shm']) expect(statSync(join(fixture.directory, `issues.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
  repair.close();
  fixture.reopen();
  expect(fixture.service.bootstrap(caller.authority)).toEqual({ ...initial, collectionRevision: 1 });
  for (const suffix of ['', '-wal', '-shm']) expect(statSync(join(fixture.directory, `issues.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
});

test('a permissive umask in an isolated process cannot expose SQLite sidecars', async () => {
  fixture.service.close();
  const childDir = join(fixture.directory, 'permissive');
  mkdirSync(childDir, { mode: 0o777 });
  const processHandle = Bun.spawn([process.execPath, '-e', `
    import { IssueStore } from ${JSON.stringify(new URL('../store.ts', import.meta.url).pathname)};
    import { statSync } from 'node:fs';
    import { join } from 'node:path';
    process.umask(0);
    const store = new IssueStore(process.argv[1]);
    for (const suffix of ['', '-wal', '-shm']) {
      if ((statSync(join(process.argv[1], 'issues.sqlite' + suffix)).mode & 0o777) !== 0o600) process.exit(1);
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
    symlinkSync(join(fixture.directory, 'issues.sqlite'), join(directory, `issues.sqlite${suffix}`));
    expect(() => new IssueStore(directory)).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
  }
  const directory = join(fixture.directory, 'nonregular');
  mkdirSync(directory);
  mkdirSync(join(directory, 'issues.sqlite'));
  expect(() => new IssueStore(directory)).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
});

test('rolls back domain, history, and retry record together and fences unknown commit failures', () => {
  const first = fixture.create();
  const request = fixture.request({ action: 'close', issueId: first.issue.id, expectedRevision: 1, comment: 'Atomic close.' });
  fixture.controls.failCommit = true;
  expect(() => fixture.service.executeHttp(request, caller)).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
  expect(() => fixture.service.list({})).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
  expect(fixture.invalidations).toEqual([1]);
  fixture.reopen();
  expect(fixture.service.read({ issueId: first.issue.id }, caller.authority).issue).toEqual(first.issue);
  expect(fixture.service.comments({ issueId: first.issue.id }, caller.authority).items).toHaveLength(0);
  expect(fixture.service.history({ issueId: first.issue.id }).items).toHaveLength(1);
  const retried = fixture.service.executeHttp(request, caller);
  expect(retried.issue.status).toBe('closed');
  expect(fixture.service.history({ issueId: first.issue.id }).items).toHaveLength(3);
});

test('rejects unknown schema and inconsistent normalized records without rebuilding', () => {
  const first = fixture.create();
  fixture.store.read((database) => database.query("UPDATE issues SET status='in-progress' WHERE number=?").run(first.issue.number));
  expect(() => fixture.service.list({})).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
  const database = new Database(join(fixture.directory, 'issues.sqlite'));
  database.exec('PRAGMA user_version=99');
  database.close();
  expect(() => new IssueStore(fixture.directory)).toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
});

test('counter exhaustion rejects before partial effects', () => {
  const first = fixture.create();
  fixture.store.read((database) => database.query('UPDATE issue_meta SET revision=?').run(Number.MAX_SAFE_INTEGER - 1));
  expect(() => fixture.write({ action: 'comment', issueId: first.issue.id, body: 'Must roll back.' }))
    .toThrow(expect.objectContaining({ code: 'ISSUE_LIMIT_REACHED' }));
  expect(fixture.service.comments({ issueId: first.issue.id }, caller.authority).items).toHaveLength(0);
  expect(fixture.service.history({ issueId: first.issue.id }).items).toHaveLength(1);
});

test('asynchronous transaction callbacks are rejected and cannot commit an unawaited mutation', () => {
  expect(() => fixture.store.transaction(() => Promise.resolve('invalid')))
    .toThrow(expect.objectContaining({ code: 'ISSUE_STORAGE_UNAVAILABLE' }));
  fixture.reopen();
  expect(fixture.service.list({}).items).toEqual([]);
});
