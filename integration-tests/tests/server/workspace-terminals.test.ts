import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../../../common/json.js';
import {
  parseTerminalStreamServerMessage,
  type TerminalCreateResponse,
  type TerminalListResponse,
  type TerminalRenameResponse,
  type TerminalStreamClientMessage,
  type TerminalStreamServerMessage,
  type TerminalTerminateResponse,
} from '../../../common/terminal.js';
import { webSocketProtocolsForAuth } from '../../../common/ws-auth.js';
import { parsePrimaryWsServerMessage } from '../../../common/ws-protocol.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';

interface TerminalCleanupResponse {
  spawned: number;
  kills: number;
  error: string | null;
}

class TerminalClient {
  readonly messages: TerminalStreamServerMessage[] = [];
  readonly #socket: WebSocket;
  readonly #closed = new Deferred<void>();
  #changed = new Deferred<void>();
  #error: unknown;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('close', () => {
      this.#closed.resolve();
      this.#notify();
    });
    socket.addEventListener('message', (event) => {
      try {
        const payload: unknown = JSON.parse(String(event.data));
        if (!isRecord(payload) || !parsePrimaryWsServerMessage(payload)) {
          throw new Error('Invalid primary WebSocket message');
        }
        const terminal = parseTerminalStreamServerMessage(payload);
        if (terminal) this.messages.push(terminal);
      } catch (error) {
        this.#error = error;
      }
      this.#notify();
    });
  }

  static async connect(fixture: IntegrationFixture): Promise<TerminalClient> {
    const socket = new WebSocket(
      fixture.garcon.baseUrl.replace(/^http/, 'ws') + '/ws',
      webSocketProtocolsForAuth(fixture.authToken),
    );
    const client = new TerminalClient(socket);
    const opened = new Deferred<void>();
    socket.addEventListener('open', () => opened.resolve(), { once: true });
    socket.addEventListener(
      'error',
      () => opened.reject(new Error('Terminal WebSocket failed to connect')),
      { once: true },
    );
    try {
      await withTimeout(opened.promise, 5_000, () => 'Terminal WebSocket did not open');
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  send(message: TerminalStreamClientMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  async waitFor<T>(
    select: (messages: readonly TerminalStreamServerMessage[]) => T | undefined,
  ): Promise<T> {
    const deadline = performance.now() + 5_000;
    for (;;) {
      if (this.#error) throw this.#error;
      const result = select(this.messages);
      if (result !== undefined) return result;
      if (this.#closed.settled)
        throw new Error('Terminal WebSocket closed before the expected message');
      await withTimeout(
        this.#changed.promise,
        Math.max(1, deadline - performance.now()),
        () => `Missing terminal message; received ${JSON.stringify(this.messages)}`,
      );
    }
  }

  waitForOutput(text: string): Promise<number> {
    return this.waitFor((messages) => {
      let output = '';
      for (const message of messages) {
        if (message.type !== 'terminal-output') continue;
        output += message.data;
        if (output.includes(text)) return message.sequence;
      }
      return undefined;
    });
  }

  async close(): Promise<void> {
    this.#socket.close();
    await withTimeout(this.#closed.promise, 5_000, () => 'Terminal WebSocket did not close');
  }

  #notify(): void {
    this.#changed.resolve();
    this.#changed = new Deferred<void>();
  }
}

describe('workspace terminals through authenticated HTTP and WebSocket', () => {
  test.each(['exit', 'rename'])(
    'initial truncation retains reentrant %s metadata and subsequent output',
    async (action) => {
      await withIntegrationFixture(
        `workspace-terminal-replay-${action}`,
        async (fixture) => {
          const { terminal } = await fixture.client.post<TerminalCreateResponse>(
            '/api/v1/terminals',
            { requestId: 'create', requestedInitialWorkingDirectory: fixture.dirs.project },
          );
          const client = await TerminalClient.connect(fixture);
          try {
            client.send({
              type: 'terminal-attach',
              terminalId: terminal.terminalId,
              clientId: 'tab',
              afterSequence: 0,
              intent: 'restore',
            });
            await client.waitForOutput('c');
            const listed = await fixture.client.get<TerminalListResponse>('/api/v1/terminals');
            expect(client.messages.map((message) => message.type)).toEqual([
              'terminal-replay-truncated',
              'terminal-status',
              'terminal-attached',
              'terminal-output',
            ]);
            expect(client.messages[0]).toMatchObject({ firstSequence: 2 });
            expect(client.messages[2]).toMatchObject({
              terminal: listed.terminals[0],
              replay: [{ sequence: 2, data: 'b' }],
            });
            expect(listed.terminals[0]).toMatchObject(
              action === 'exit'
                ? { processStatus: 'exited', exitCode: 17, latestOutputSequence: 3 }
                : { title: 'Synthetic renamed terminal', latestOutputSequence: 3 },
            );
            expect(client.messages[3]).toMatchObject({ sequence: 3, data: 'c' });
          } finally {
            await client.close();
          }
        },
        {
          authentication: 'account',
          bindAddress: '0.0.0.0',
          preloadModules: [
            fileURLToPath(
              new URL('../../support/workspace-terminals-stream-preload.ts', import.meta.url),
            ),
          ],
          resolveServerEnvironment: () => ({ GARCON_TEST_TERMINAL_REENTRANT_METADATA: action }),
        },
      );
    },
  );

  test('takeover replays earlier bytes before output produced during peer notifications', async () => {
    await withIntegrationFixture(
      'workspace-terminal-takeover-order',
      async (fixture) => {
        const { terminal } = await fixture.client.post<TerminalCreateResponse>(
          '/api/v1/terminals',
          {
            requestId: 'create',
            requestedInitialWorkingDirectory: fixture.dirs.project,
          },
        );
        const first = await TerminalClient.connect(fixture);
        const second = await TerminalClient.connect(fixture);
        const attach = {
          type: 'terminal-attach',
          terminalId: terminal.terminalId,
          clientId: 'first',
          afterSequence: 0,
          intent: 'restore',
        } as const;
        try {
          first.send(attach);
          await first.waitFor((messages) =>
            messages.find((message) => message.type === 'terminal-attached'),
          );
          first.send({ type: 'terminal-input', terminalId: terminal.terminalId, data: 'first' });
          first.send({ type: 'terminal-input', terminalId: terminal.terminalId, data: 'second' });
          await first.waitForOutput('synthetic-echo:second');
          second.send({ ...attach, clientId: 'second', intent: 'takeover' });
          await second.waitForOutput('synthetic-during-attach');
          expect(second.messages.map((message) => message.type)).toEqual([
            'terminal-attached',
            'terminal-output',
          ]);
          expect(second.messages[0]).toMatchObject({
            type: 'terminal-attached',
            replay: [
              { sequence: 1, data: 'synthetic-echo:first' },
              { sequence: 2, data: 'synthetic-echo:second' },
              { sequence: 3, data: 'synthetic-during-takeover' },
            ],
          });
          expect(second.messages[1]).toMatchObject({
            sequence: 4,
            data: 'synthetic-during-attach',
          });
          second.send({ type: 'terminal-input', terminalId: terminal.terminalId, data: 'current' });
          expect(await second.waitForOutput('synthetic-echo:current')).toBe(5);
        } finally {
          await Promise.all([first.close(), second.close()]);
        }
      },
      {
        authentication: 'account',
        bindAddress: '0.0.0.0',
        preloadModules: [
          fileURLToPath(
            new URL('../../support/workspace-terminals-stream-preload.ts', import.meta.url),
          ),
        ],
        resolveServerEnvironment: () => ({ GARCON_TEST_TERMINAL_REENTRANT_OUTPUT: '1' }),
      },
    );
  });

  test('a refreshed HTTP retry cannot duplicate a late PTY whose cleanup failed', async () => {
    const entered = new Deferred<void>();
    const release = new Deferred<void>();
    const gate = Bun.serve({
      hostname: '0.0.0.0',
      port: 0,
      async fetch() {
        entered.resolve();
        await release.promise;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await withIntegrationFixture(
        'workspace-terminal-late-cleanup',
        async (fixture) => {
          const request = {
            requestId: 'late',
            requestedInitialWorkingDirectory: fixture.dirs.project,
          };
          const creating = fixture.client.post('/api/v1/terminals', request);
          void creating.catch(() => {});
          try {
            await withTimeout(
              entered.promise,
              5_000,
              () => 'Terminal spawn did not reach its barrier',
            );
            release.resolve();
            expect(await creating.catch((error: unknown) => error)).toMatchObject({ status: 401 });
            expect(
              await fixture.client
                .post('/api/v1/terminals', request)
                .catch((error: unknown) => error),
            ).toMatchObject({ status: 401 });
            expect(
              await fixture.client
                .post('/api/v1/terminals', { ...request, requestId: 'another' })
                .catch((error: unknown) => error),
            ).toMatchObject({ status: 429 });
            expect(
              await fixture.client.get<TerminalListResponse>('/api/v1/terminals'),
            ).toMatchObject({ terminals: [] });
            expect(
              await fixture.client.post<TerminalCleanupResponse>('/api/v1/test/terminal-cleanup', {
                refuseKill: true,
              }),
            ).toEqual({
              spawned: 1,
              kills: 2,
              error: 'terminal-internal',
            });
            expect(
              await fixture.client.post<TerminalCleanupResponse>('/api/v1/test/terminal-cleanup', {
                refuseKill: false,
              }),
            ).toEqual({
              spawned: 1,
              kills: 3,
              error: null,
            });
          } finally {
            release.resolve();
            await creating.catch(() => {});
            await fixture.client.post('/api/v1/test/terminal-cleanup', { refuseKill: false });
          }
        },
        {
          authentication: 'account',
          bindAddress: '0.0.0.0',
          preloadModules: [
            fileURLToPath(
              new URL('../../support/workspace-terminals-cleanup-preload.ts', import.meta.url),
            ),
          ],
          resolveServerEnvironment: () => ({
            GARCON_TEST_TERMINAL_GATE: `http://127.0.0.1:${gate.port}/spawn`,
          }),
        },
      );
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  });

  test.each(['expire', 'overflow'] as const)(
    'fences %s during owner output on the primary WebSocket',
    async (action) => {
      await withIntegrationFixture(
        `workspace-terminal-${action}`,
        async (fixture) => {
          const terminals: TerminalCreateResponse['terminal'][] = [];
          for (const requestId of ['first', 'second']) {
            const created = await fixture.client.post<TerminalCreateResponse>('/api/v1/terminals', {
              requestId,
              requestedInitialWorkingDirectory: fixture.dirs.project,
            });
            terminals.push(created.terminal);
          }
          const client = await TerminalClient.connect(fixture);
          try {
            for (const terminal of terminals) {
              client.send({
                type: 'terminal-attach',
                terminalId: terminal.terminalId,
                clientId: 'synthetic-tab',
                afterSequence: 0,
                intent: 'restore',
              });
              await client.waitFor((messages) =>
                messages.find(
                  (message) =>
                    message.type === 'terminal-attached' &&
                    message.terminal.terminalId === terminal.terminalId,
                ),
              );
            }
            await fixture.client.post('/api/v1/test/terminal-stream', { action });
            const expectedCode =
              action === 'expire' ? 'terminal-auth-expired' : 'terminal-backpressure';
            await client.waitFor((messages) =>
              messages.find(
                (message) => message.type === 'terminal-error' && message.code === expectedCode,
              ),
            );
            if (action === 'overflow') {
              client.send({
                type: 'terminal-input',
                terminalId: terminals[0].terminalId,
                data: 'rejected',
              });
              client.send({
                type: 'terminal-input',
                terminalId: terminals[1].terminalId,
                data: 'accepted',
              });
              await client.waitForOutput('synthetic-echo:accepted');
              expect(client.messages).toContainEqual(
                expect.objectContaining({
                  type: 'terminal-error',
                  terminalId: terminals[0].terminalId,
                  code: 'terminal-not-attached',
                }),
              );
              expect(
                client.messages.filter((message) => message.type === 'terminal-output-fragment'),
              ).toEqual([]);
            } else {
              expect(
                client.messages.filter((message) => message.type === 'terminal-output'),
              ).toEqual([]);
            }
            const listed = await fixture.client.get<TerminalListResponse>('/api/v1/terminals');
            expect(listed.terminals.map((terminal) => terminal.attachmentStatus)).toEqual(
              action === 'expire' ? ['detached', 'detached'] : ['detached', 'attached'],
            );
          } finally {
            await client.close();
          }
        },
        {
          authentication: 'account',
          bindAddress: '0.0.0.0',
          preloadModules: [
            fileURLToPath(
              new URL('../../support/workspace-terminals-stream-preload.ts', import.meta.url),
            ),
          ],
        },
      );
    },
  );

  test('waits for an admitted create to settle without spawning after shutdown', async () => {
    const resolving = new Deferred<void>();
    const stopping = new Deferred<void>();
    const release = new Deferred<void>();
    const gate = Bun.serve({
      hostname: '0.0.0.0',
      port: 0,
      async fetch(request) {
        switch (new URL(request.url).pathname) {
          case '/resolving':
            resolving.resolve();
            await release.promise;
            break;
          case '/shutdown-entered':
            stopping.resolve();
            release.resolve();
            break;
          default:
            return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      await withIntegrationFixture(
        'workspace-terminal-shutdown',
        async (fixture) => {
          const creation = fixture.client.post('/api/v1/terminals', {
            requestId: 'synthetic-held-create',
            requestedInitialWorkingDirectory: fixture.dirs.project,
          });
          void creation.catch(() => {});
          let shutdown: Promise<void> | undefined;
          try {
            await withTimeout(
              resolving.promise,
              5_000,
              () => 'Terminal create did not reach directory validation',
            );
            shutdown = fixture.garcon.stop();
            void shutdown.catch(() => {});
            await withTimeout(
              stopping.promise,
              5_000,
              () => 'Server did not fence terminal creation during shutdown',
            );
            await shutdown;
            expect(await readFile(join(fixture.dirs.root, 'terminal-lifecycle.log'), 'utf8')).toBe(
              'rejected\nsettled\n',
            );
          } finally {
            release.resolve();
            await Promise.allSettled([creation, shutdown]);
          }
        },
        {
          authentication: 'account',
          bindAddress: '0.0.0.0',
          preloadModules: [
            fileURLToPath(
              new URL('../../support/workspace-terminals-lifecycle-preload.ts', import.meta.url),
            ),
          ],
          resolveServerEnvironment: (directories) => ({
            GARCON_TEST_TERMINAL_SCENARIO: 'shutdown',
            GARCON_TEST_TERMINAL_GATE: `http://127.0.0.1:${gate.port}/`,
            GARCON_TEST_TERMINAL_DIRECTORY: directories.project,
            GARCON_TEST_TERMINAL_OBSERVATION: join(directories.root, 'terminal-lifecycle.log'),
          }),
        },
      );
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  });

  test('reconciles one admitted create after the HTTP client disconnects', async () => {
    const resolving = new Deferred<void>();
    const disconnected = new Deferred<void>();
    const release = new Deferred<void>();
    const gate = Bun.serve({
      hostname: '0.0.0.0',
      port: 0,
      async fetch(request) {
        switch (new URL(request.url).pathname) {
          case '/resolving':
            resolving.resolve();
            await release.promise;
            break;
          case '/disconnected':
            disconnected.resolve();
            break;
          case '/shutdown-entered':
            break;
          default:
            return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      await withIntegrationFixture(
        'workspace-terminal-disconnect',
        async (fixture) => {
          const request = {
            requestId: 'synthetic-disconnect',
            requestedInitialWorkingDirectory: fixture.dirs.project,
          };
          const lifetime = new AbortController();
          const creation = fetch(`${fixture.garcon.baseUrl}/api/v1/terminals`, {
            method: 'POST',
            signal: lifetime.signal,
            headers: {
              Authorization: `Bearer ${fixture.authToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(request),
          });
          void creation.catch(() => {});
          try {
            await withTimeout(
              resolving.promise,
              5_000,
              () => 'Terminal create did not reach its validation barrier',
            );
            lifetime.abort();
            await expect(creation).rejects.toMatchObject({ name: 'AbortError' });
            await withTimeout(
              disconnected.promise,
              5_000,
              () => 'Server did not observe the aborted HTTP request',
            );
            release.resolve();
            const reconciled = await fixture.client.post<TerminalCreateResponse>(
              '/api/v1/terminals',
              request,
            );
            const listed = await fixture.client.get<TerminalListResponse>('/api/v1/terminals');
            expect(listed.terminals.map((terminal) => terminal.terminalId)).toEqual([
              reconciled.terminal.terminalId,
            ]);
            const observations = await readFile(
              join(fixture.dirs.root, 'terminal-lifecycle.log'),
              'utf8',
            );
            expect(observations).toBe('created\ncreated\n');
            await fixture.client.delete('/api/v1/terminals', {
              terminalId: reconciled.terminal.terminalId,
              requestId: 'synthetic-disconnect-cleanup',
            });
          } finally {
            release.resolve();
            lifetime.abort();
            await Promise.allSettled([creation]);
          }
        },
        {
          authentication: 'account',
          bindAddress: '0.0.0.0',
          serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' },
          preloadModules: [
            fileURLToPath(
              new URL('../../support/workspace-terminals-lifecycle-preload.ts', import.meta.url),
            ),
          ],
          resolveServerEnvironment: (directories) => ({
            GARCON_TEST_TERMINAL_SCENARIO: 'disconnect',
            GARCON_TEST_TERMINAL_GATE: `http://127.0.0.1:${gate.port}/`,
            GARCON_TEST_TERMINAL_DIRECTORY: directories.project,
            GARCON_TEST_TERMINAL_OBSERVATION: join(directories.root, 'terminal-lifecycle.log'),
          }),
        },
      );
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  });

  test('preserves canonical cwd, request identity, attachment ownership, replay offsets, and restart expiry', async () => {
    await withIntegrationFixture(
      'workspace-terminals',
      async (fixture) => {
        const directory = join(fixture.dirs.project, 'working');
        const alias = join(fixture.dirs.project, 'working-alias');
        await mkdir(directory);
        await symlink(directory, alias);
        const unauthorized = await fetch(`${fixture.garcon.baseUrl}/api/v1/terminals`, {
          signal: AbortSignal.timeout(5_000),
        });
        expect(unauthorized.status).toBe(401);
        await expect(
          fixture.client.post('/api/v1/terminals', {
            requestId: 'outside',
            requestedInitialWorkingDirectory: fixture.dirs.root,
          }),
        ).rejects.toMatchObject({ status: 422 });
        const request = { requestId: 'synthetic-create', requestedInitialWorkingDirectory: alias };
        const created = await fixture.client.post<TerminalCreateResponse>(
          '/api/v1/terminals',
          request,
        );
        expect(created.terminal.initialWorkingDirectory).toBe(directory);
        expect(
          await fixture.client.post<TerminalCreateResponse>('/api/v1/terminals', {
            ...request,
            requestedInitialWorkingDirectory: null,
          }),
        ).toEqual(created);
        const terminalId = created.terminal.terminalId;
        const first = await TerminalClient.connect(fixture);
        let second: TerminalClient | undefined;
        let replacement: TerminalClient | undefined;
        try {
          first.send({
            type: 'terminal-attach',
            terminalId,
            clientId: 'synthetic-tab',
            afterSequence: 0,
            intent: 'restore',
          });
          await first.waitFor((messages) =>
            messages.find((message) => message.type === 'terminal-attached'),
          );
          first.send({ type: 'terminal-resize', terminalId, cols: 100, rows: 30 });
          first.send({
            type: 'terminal-input',
            terminalId,
            data: "stty -echo; printf 'READY:%s\\n' 'synthetic'; pwd; stty size\n",
          });
          await first.waitForOutput(directory);
          const offset = await first.waitForOutput('30 100');

          second = await TerminalClient.connect(fixture);
          second.send({
            type: 'terminal-attach',
            terminalId,
            clientId: 'synthetic-tab',
            afterSequence: offset,
            intent: 'restore',
          });
          const attached = await second.waitFor((messages) =>
            messages.find((message) => message.type === 'terminal-attached'),
          );
          if (attached.type !== 'terminal-attached') throw new Error('Expected attached terminal');
          expect(attached.replay.every((chunk) => chunk.sequence > offset)).toBe(true);
          first.send({ type: 'terminal-input', terminalId, data: 'touch stale-peer-write\n' });
          expect(
            await first.waitFor((messages) =>
              messages.find((message) => message.type === 'terminal-error'),
            ),
          ).toMatchObject({ terminalId, code: 'terminal-not-attached' });
          second.send({
            type: 'terminal-input',
            terminalId,
            data: "printf 'CURRENT:%s\\n' 'synthetic'\n",
          });
          await second.waitForOutput('CURRENT:synthetic');
          await expect(stat(join(directory, 'stale-peer-write'))).rejects.toMatchObject({
            code: 'ENOENT',
          });

          const renamed = await fixture.client.patch<TerminalRenameResponse>('/api/v1/terminals', {
            terminalId,
            title: 'Synthetic shell',
          });
          expect(renamed).toMatchObject({ success: true, title: 'Synthetic shell' });
          expect(
            await first.waitFor((messages) =>
              messages.find((message) => message.type === 'terminal-status'),
            ),
          ).toMatchObject({ terminal: { terminalId, title: 'Synthetic shell' } });
          const termination = { terminalId, requestId: 'synthetic-terminate' };
          const terminated = await fixture.client.delete<TerminalTerminateResponse>(
            '/api/v1/terminals',
            termination,
          );
          expect(terminated).toMatchObject({ success: true, terminalId });
          expect(
            await fixture.client.delete<TerminalTerminateResponse>(
              '/api/v1/terminals',
              termination,
            ),
          ).toEqual(terminated);
          await second.waitFor((messages) =>
            messages.find((message) => message.type === 'terminal-terminated'),
          );
          expect(
            (await fixture.client.get<TerminalListResponse>('/api/v1/terminals')).terminals,
          ).toEqual([]);

          const retained = await fixture.client.post<TerminalCreateResponse>('/api/v1/terminals', {
            requestId: 'synthetic-restart',
            requestedInitialWorkingDirectory: directory,
          });
          await first.close();
          await second.close();
          await fixture.restartGarcon();
          expect(
            (await fixture.client.get<TerminalListResponse>('/api/v1/terminals')).terminals,
          ).toEqual([]);
          replacement = await TerminalClient.connect(fixture);
          replacement.send({
            type: 'terminal-attach',
            terminalId: retained.terminal.terminalId,
            clientId: 'synthetic-tab',
            afterSequence: 0,
            intent: 'restore',
          });
          expect(
            await replacement.waitFor((messages) =>
              messages.find((message) => message.type === 'terminal-error'),
            ),
          ).toMatchObject({ code: 'terminal-not-found', terminalId: retained.terminal.terminalId });
        } finally {
          await Promise.all([first.close(), second?.close(), replacement?.close()]);
        }
      },
      {
        authentication: 'account',
        bindAddress: '0.0.0.0',
        serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' },
      },
    );
  });
});
