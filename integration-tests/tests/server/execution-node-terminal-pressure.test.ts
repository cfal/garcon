import { expect, test } from 'bun:test';
import { spawn, type IPty } from 'bun-pty';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalStreamServerMessage } from '../../../common/terminal.js';
import { AgentRpc } from '../../../server/execution-nodes/rpc.js';
import { SessionTransport } from '../../../server/execution-nodes/session-transport.js';
import { TerminalWorker } from '../../../server/execution-nodes/terminal-worker.js';
import { TerminalRuntime } from '../../../server/terminals/node-service.js';
import { withTimeout } from '../../support/deferred.js';

test('real PTY keeps draining and records exit after reliable transport saturation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-terminal-pressure-'));
  const authority = { key: 'synthetic-user', expiresAtMs: null };
  const exited = Promise.withResolvers<number>();
  let pty!: IPty;
  const runtime = new TerminalRuntime({ projectBasePath: directory, spawnPty: (_shell, _args, options) => {
    pty = spawn('/bin/sh', ['-c', [
      'stty -echo',
      'IFS= read -r first',
      "printf 'pressure\\n'",
      'IFS= read -r second',
      "printf 'drained-after-pressure\\n'",
      'exit 7',
    ].join('\n')], { ...options, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, TERM: 'xterm-256color' } });
    pty.onExit(({ exitCode }) => exited.resolve(exitCode));
    return pty;
  } });
  const service = runtime.service('local');
  const retired = Promise.withResolvers<Error>();
  const transport = new SessionTransport('session', 'runtime', error => retired.resolve(error), { maxRetainedFrames: 4 });
  const socket = transport.attach({ send() {}, close() {} }, 0);
  socket.receive(JSON.stringify({ kind: 'receipt', through: 0 }));
  const worker = new TerminalWorker(service, new AgentRpc(transport));
  try {
    const inventory = await service.list(authority);
    const { terminal } = await service.create(authority, {
      expectedTerminalRuntimeId: inventory.terminalRuntimeId, requestId: 'create', requestedInitialWorkingDirectory: null,
    });
    await worker.handle({ method: 'terminals.attach', request: {
      authority, attachmentId: 'attachment', attachmentEpoch: inventory.attachmentEpoch,
      type: 'terminal-attach', terminalId: terminal.terminalId, clientId: 'browser', intent: 'restore', afterSequence: 0,
    } });
    while (transport.channel.retainedFrames < 4) transport.send('reliable traffic');
    pty.write('\n');
    await withTimeout(retired.promise, 5_000, () => 'Terminal output did not exhaust reliable capacity');
    expect(transport.connected).toBe(false);
    expect((await service.list(authority)).terminals[0]?.attachmentStatus).toBe('detached');

    service.dispose();
    pty.write('\n');
    expect(await withTimeout(exited.promise, 5_000, () => 'PTY stopped processing output or exit')).toBe(7);
    const replacement = runtime.service('local');
    try {
      const after = await replacement.list(authority);
      expect(after.terminalRuntimeId).toBe(inventory.terminalRuntimeId);
      expect(after.terminals[0]).toMatchObject({ terminalId: terminal.terminalId, processStatus: 'exited', exitCode: 7 });
      const messages: TerminalStreamServerMessage[] = [];
      await replacement.attach(authority, {
        connectionId: 'replacement', ownedTerminalIds: new Set(), sendTerminalMessage: message => { messages.push(message); },
      }, {
        type: 'terminal-attach', terminalId: terminal.terminalId, attachmentEpoch: after.attachmentEpoch,
        clientId: 'browser', intent: 'restore', afterSequence: 0,
      });
      const replay = messages.find(message => message.type === 'terminal-attached')?.replay.map(chunk => chunk.data).join('');
      expect(replay).toContain('pressure');
      expect(replay).toContain('drained-after-pressure');
    } finally { replacement.dispose(); }
  } finally {
    worker.disconnect(); transport.close(); service.dispose(); runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
