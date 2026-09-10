import { expect, spyOn, test } from 'bun:test';
import { initializeTerminalRuntime } from '../setup.js';
import { LocalWorkspaceTerminalService } from '../../execution-node/local-workspace-terminals.js';
import { WorkspaceTerminalError } from '../../execution-nodes/workspace-terminals.js';

function runtime() {
  return initializeTerminalRuntime(
    { projectBasePath: '/synthetic-project', userShell: '/bin/sh' },
    {},
  );
}

test('shares one terminal owner and closes admission before awaiting bounded shutdown', async () => {
  const terminals = runtime();
  const service = terminals.service;
  const stopping = Promise.withResolvers();
  const originalShutdown = service.shutdown.bind(service);
  const shutdown = spyOn(service, 'shutdown').mockImplementation(() => {
    void originalShutdown();
    return stopping.promise;
  });
  try {
    expect(service).toBeInstanceOf(LocalWorkspaceTerminalService);
    expect(terminals.stream.manager).toBe(service);
    const cleanup = terminals.shutdown();
    expect(shutdown).toHaveBeenCalledTimes(1);
    let refusal;
    try {
      service.list({ key: 'local', expiresAtMs: null });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(WorkspaceTerminalError);
    expect(refusal).toMatchObject({ code: 'terminal-internal' });
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    stopping.resolve();
    expect(await cleanup).toBe(true);
  } finally {
    stopping.resolve();
    shutdown.mockRestore();
    await service.shutdown();
  }
});

test.each(['throw', 'rejection'])(
  'reports terminal cleanup %s without rejecting server cleanup',
  async (failure) => {
    const terminals = runtime();
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const shutdown = spyOn(terminals.service, 'shutdown').mockImplementation(() => {
      const error = new Error('Synthetic terminal cleanup failure');
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    });
    try {
      expect(await terminals.shutdown()).toBe(false);
      expect(warning.mock.calls.flat().join(' ')).toContain('Synthetic terminal cleanup failure');
    } finally {
      shutdown.mockRestore();
      warning.mockRestore();
      await terminals.service.shutdown();
    }
  },
);
