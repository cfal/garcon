import { expect, test } from 'bun:test';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { TERMINAL_SESSION_LIMIT } from '../../../common/terminal.js';
import { LocalWorkspaceTerminalService } from '../../execution-node/local-workspace-terminals.js';
import { WorkspaceTerminalError } from '../../execution-nodes/workspace-terminals.js';
import { terminalErrorResponse } from '../terminal-http-error.js';
import createTerminalRoutes from '../terminals.js';

test.each([
  ['terminal-not-found', 404],
  ['terminal-limit', 409],
  ['terminal-validation', 422],
  ['terminal-takeover-required', 409],
  ['terminal-not-attached', 409],
  ['terminal-process-exited', 409],
  ['terminal-replay-sequence', 400],
  ['terminal-backpressure', 429],
  ['terminal-auth-expired', 401],
  ['terminal-internal', 500],
])('maps %s to HTTP %i without embedding status in the owner error', async (code, status) => {
  const error = new WorkspaceTerminalError(code, 'Synthetic terminal failure.');
  expect(error).not.toHaveProperty('status');
  const response = terminalErrorResponse(error);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({
    success: false,
    error: 'Synthetic terminal failure.',
    errorCode: code,
    retryable: status >= 500,
  });
});

test('sanitizes an unexpected owner failure', async () => {
  const response = terminalErrorResponse(new Error('Synthetic private diagnostic'));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    success: false,
    error: 'Terminal operation failed.',
    errorCode: 'terminal-internal',
    retryable: true,
  });
});

test.each(['unknown-terminal-code', 'constructor', '__proto__'])(
  'sanitizes a malformed owner error code %s without returning HTTP 200',
  async (code) => {
    const response = terminalErrorResponse(
      new WorkspaceTerminalError(code, 'Synthetic diagnostic'),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Terminal operation failed.',
      errorCode: 'terminal-internal',
      retryable: true,
    });
  },
);

test.each([
  ['directory', 'terminal-validation', 422],
  ['limit', 'terminal-limit', 409],
  ['capacity', 'terminal-backpressure', 429],
])(
  'preserves repeated create %s failures through the HTTP adapter',
  async (scenario, code, status) => {
    let directoryAvailable = scenario !== 'directory';
    let spawnCount = 0;
    const owner = new LocalWorkspaceTerminalService({
      projectBasePath: homedir(),
      shell: '/bin/sh',
      environment: {},
      requestResultsPerPrincipal: scenario === 'capacity' ? 1 : undefined,
      assertProjectPathAllowed: async (target) => {
        if (!directoryAvailable) throw new Error('Synthetic unavailable directory');
        return realpath(target);
      },
      spawnPty: () => {
        spawnCount += 1;
        return { write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
      },
    });
    const principal = { key: 'local', expiresAtMs: null };
    const count = scenario === 'limit' ? TERMINAL_SESSION_LIMIT : scenario === 'capacity' ? 1 : 0;
    const created = [];
    try {
      for (let index = 0; index < count; index += 1) {
        created.push(
          await owner.create(principal, {
            requestId: `create-${index}`,
            requestedInitialWorkingDirectory: null,
          }),
        );
      }
      const post = createTerminalRoutes(owner)['/api/v1/terminals'].POST;
      const url = new URL('http://localhost/api/v1/terminals');
      const attempt = () =>
        post(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: 'refused', requestedInitialWorkingDirectory: null }),
          }),
          url,
          undefined,
          { principal },
        );
      const first = await attempt();
      const expected = { success: false, errorCode: code, retryable: false };
      expect(first.status).toBe(status);
      const body = await first.json();
      expect(body).toMatchObject(expected);
      directoryAvailable = true;
      if (scenario === 'limit')
        await owner.terminate(principal, created[0].terminal.terminalId, 'free-slot');
      const repeated = await attempt();
      expect(repeated.status).toBe(status);
      expect(await repeated.json()).toEqual(body);
      expect(spawnCount).toBe(count);
    } finally {
      await owner.shutdown();
    }
  },
);
