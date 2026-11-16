import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { getTransactionRollbackFailure, runTransaction } from '../sqlite-operations.ts';
import { measureLedgerWrite } from '../write-timings.ts';

let db;
let wall;
let cpu;
let warning;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE entries(value TEXT)');
  wall = 0;
  cpu = 0;
  spyOn(performance, 'now').mockImplementation(() => wall);
  spyOn(process, 'cpuUsage').mockImplementation(() => ({ user: cpu, system: 0 }));
  warning = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  db.close();
});

function report() {
  expect(warning).toHaveBeenCalledTimes(1);
  return JSON.parse(warning.mock.calls[0][2]);
}

it('preserves the synchronous result and stays quiet for a fast write', () => {
  const result = measureLedgerWrite('ledger staging batch', { rows: 1 }, timings =>
    runTransaction(db, () => {
      db.exec("INSERT INTO entries VALUES ('synthetic')");
      wall += 49;
      return 42;
    }, timings));
  expect(result).toBe(42);
  expect(db.query('SELECT count(*) AS count FROM entries').get().count).toBe(1);
  expect(warning).not.toHaveBeenCalled();
});

it('separates encoding, validation, statements, and a slow commit without logging contents', () => {
  const exec = db.exec.bind(db);
  spyOn(db, 'exec').mockImplementation(sql => {
    if (sql === 'COMMIT') { wall += 600; cpu += 1000; }
    return exec(sql);
  });
  measureLedgerWrite('ledger staging batch', { firstOrdinal: 501, rows: 1, payloadCodeUnits: 12 }, timings => {
    timings.phase('encode');
    wall += 8; cpu += 7000;
    timings.phase('validate');
    wall += 4; cpu += 3000;
    runTransaction(db, () => {
      db.exec("INSERT INTO entries VALUES ('synthetic private content')");
      wall += 2; cpu += 1000;
    }, timings);
  });
  expect(report()).toMatchObject({
    operation: 'ledger staging batch', firstOrdinal: 501, rows: 1, payloadCodeUnits: 12, wallMs: 614,
    phases: {
      encode: { wallMs: 8, processCpuMs: 7 }, validate: { wallMs: 4, processCpuMs: 3 },
      statements: { wallMs: 2, processCpuMs: 1 }, commit: { wallMs: 600, processCpuMs: 1 },
    },
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic private content');
});

it.each([false, true])('preserves commit failure and rollback diagnostics (rollback fails: %s)', rollbackFails => {
  const failure = new Error('synthetic commit failure');
  const rollbackFailure = new Error('synthetic rollback failure');
  const exec = db.exec.bind(db);
  spyOn(db, 'exec').mockImplementation(sql => {
    if (sql === 'COMMIT') { wall += 60; throw failure; }
    if (sql === 'ROLLBACK') {
      wall += 10;
      if (rollbackFails) throw rollbackFailure;
    }
    return exec(sql);
  });
  let caught;
  try {
    measureLedgerWrite('ledger replacement promotion', {}, timings =>
      runTransaction(db, () => db.exec("INSERT INTO entries VALUES ('synthetic')"), timings));
  } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(getTransactionRollbackFailure(caught)).toBe(rollbackFails ? rollbackFailure : null);
  expect(report()).toMatchObject({ phases: { commit: { wallMs: 60 }, rollback: { wallMs: 10 } } });
  if (!rollbackFails) expect(db.query('SELECT count(*) AS count FROM entries').get().count).toBe(0);
});

it('preserves a committed result when diagnostic output throws', () => {
  warning.mockImplementation(() => { throw new Error('synthetic logging failure'); });
  expect(measureLedgerWrite('ledger seed promotion', {}, timings => runTransaction(db, () => {
    wall += 60;
    db.exec("INSERT INTO entries VALUES ('synthetic')");
    return 42;
  }, timings))).toBe(42);
  expect(db.query('SELECT count(*) AS count FROM entries').get().count).toBe(1);
});

it('preserves storage and rollback failure identities when diagnostic output throws', () => {
  const failure = new Error('synthetic storage failure');
  const rollbackFailure = new Error('synthetic rollback failure');
  warning.mockImplementation(() => { throw new Error('synthetic logging failure'); });
  const exec = db.exec.bind(db);
  spyOn(db, 'exec').mockImplementation(sql => {
    if (sql === 'ROLLBACK') throw rollbackFailure;
    return exec(sql);
  });
  let caught;
  try {
    measureLedgerWrite('ledger seed promotion', {}, timings => runTransaction(db, () => {
      wall += 60;
      throw failure;
    }, timings));
  } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(getTransactionRollbackFailure(caught)).toBe(rollbackFailure);
});
