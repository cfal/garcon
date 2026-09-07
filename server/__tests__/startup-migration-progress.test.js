import { afterEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runCarryOverMigrationAtStartup } from '../server.ts';

const originalDateNow = Date.now;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

afterEach(() => {
  Date.now = originalDateNow;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe('startup carryover migration progress', () => {
  it('finishes the version ladder before ownership recovery can rewrite the registry', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const finishAt = source.indexOf('await workspaceMigrations.finish()');
    const recoverAt = source.indexOf('await agentOwnership.initialize()');

    expect(finishAt).toBeGreaterThan(-1);
    expect(recoverAt).toBeGreaterThan(-1);
    expect(finishAt).toBeLessThan(recoverAt);
  });

  it('logs start, bounded elapsed progress, and completion', async () => {
    let now = 1_000;
    let heartbeat;
    let completeMigration;
    const intervalHandle = Symbol('interval');
    const info = mock(() => undefined);
    const setIntervalMock = mock((callback) => {
      heartbeat = callback;
      return intervalHandle;
    });
    const clearIntervalMock = mock(() => undefined);

    Date.now = () => now;
    globalThis.setInterval = setIntervalMock;
    globalThis.clearInterval = clearIntervalMock;

    const migration = new Promise((resolve) => {
      completeMigration = resolve;
    });
    const running = runCarryOverMigrationAtStartup(async () => migration, { info });

    expect(info).toHaveBeenLastCalledWith(
      'Workspace history migration started. This one-time upgrade may take several minutes.',
    );
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 10_000);

    now = 11_400;
    heartbeat();
    expect(info).toHaveBeenLastCalledWith(
      'Workspace history migration is still running (10s elapsed).',
    );

    now = 13_800;
    completeMigration();
    await running;

    expect(clearIntervalMock).toHaveBeenCalledWith(intervalHandle);
    expect(info.mock.calls).toEqual([
      ['Workspace history migration started. This one-time upgrade may take several minutes.'],
      ['Workspace history migration is still running (10s elapsed).'],
      ['Workspace history migration completed (12s elapsed).'],
    ]);
  });

  it('clears the heartbeat without logging completion when migration fails', async () => {
    const intervalHandle = Symbol('interval');
    const migrationError = new Error('migration failed');
    const info = mock(() => undefined);
    const setIntervalMock = mock(() => intervalHandle);
    const clearIntervalMock = mock(() => undefined);

    globalThis.setInterval = setIntervalMock;
    globalThis.clearInterval = clearIntervalMock;

    await expect(runCarryOverMigrationAtStartup(async () => {
      throw migrationError;
    }, { info })).rejects.toBe(migrationError);

    expect(clearIntervalMock).toHaveBeenCalledWith(intervalHandle);
    expect(info.mock.calls).toEqual([
      ['Workspace history migration started. This one-time upgrade may take several minutes.'],
    ]);
  });
});
