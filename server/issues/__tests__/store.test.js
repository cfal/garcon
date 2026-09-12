import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { issueFixture, caller } from './fixture.js';
import { IssueStore } from '../store.js';

let fixture;
beforeEach(() => { fixture = issueFixture(); });
afterEach(() => { fixture.cleanup(); });

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
