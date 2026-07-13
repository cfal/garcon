import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { TerminalManager, TerminalManagerError } from '../terminal-manager.ts';

class FakePty {
  dataListeners = [];
  exitListeners = [];
  writes = [];
  resizes = [];
  operations = [];
  killCount = 0;

  onData(listener) {
    this.dataListeners.push(listener);
    return { dispose() {} };
  }

  onExit(listener) {
    this.exitListeners.push(listener);
    return { dispose() {} };
  }

  write(data) {
    this.writes.push(data);
    this.operations.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
    this.operations.push(`${cols}x${rows}`);
  }

  kill() {
    this.killCount += 1;
  }

  emitData(data) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode) {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

function principal(key) {
  return {
    mode: 'authenticated',
    key,
    username: key,
    expiresAtMs: Date.now() + 60_000,
  };
}

function peer(connectionId) {
  return {
    connectionId,
    ownedTerminalIds: new Set(),
    messages: [],
    sendTerminalMessage(message) {
      this.messages.push(message);
    },
  };
}

let projectPath;
let originalProjectBaseDir;

beforeEach(async () => {
  originalProjectBaseDir = process.env.GARCON_PROJECT_BASE_DIR;
  projectPath = path.join(
    os.tmpdir(),
    `garcon-terminal-manager-${randomUUID()}`,
  );
  await fs.mkdir(projectPath, { recursive: true });
  process.env.GARCON_PROJECT_BASE_DIR = projectPath;
});

afterEach(async () => {
  if (originalProjectBaseDir === undefined)
    delete process.env.GARCON_PROJECT_BASE_DIR;
  else process.env.GARCON_PROJECT_BASE_DIR = originalProjectBaseDir;
  await fs.rm(projectPath, { recursive: true, force: true });
});

describe('TerminalManager', () => {
  it('creates idempotently, isolates principals, and retains exited sessions', async () => {
    const ptys = [];
    const manager = new TerminalManager({
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const alice = principal('alice');
    const bob = principal('bob');
    const request = {
      requestId: 'create-1',
      requestedInitialWorkingDirectory: projectPath,
    };

    const first = await manager.create(alice, request);
    const repeated = await manager.create(alice, request);
    expect(repeated).toEqual(first);
    expect(ptys).toHaveLength(1);
    expect(manager.list(bob)).toEqual([]);

    ptys[0].emitExit(7);
    expect(manager.list(alice)[0]).toMatchObject({
      processStatus: 'exited',
      exitCode: 7,
    });
  });

  it('enforces the principal cap under concurrent creation', async () => {
    const manager = new TerminalManager({ spawnPty: () => new FakePty() });
    const alice = principal('alice');
    for (let index = 0; index < 7; index += 1) {
      await manager.create(alice, {
        requestId: `seed-${index}`,
        requestedInitialWorkingDirectory: projectPath,
      });
    }

    const results = await Promise.allSettled([
      manager.create(alice, {
        requestId: 'race-a',
        requestedInitialWorkingDirectory: projectPath,
      }),
      manager.create(alice, {
        requestId: 'race-b',
        requestedInitialWorkingDirectory: projectPath,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection.reason).toBeInstanceOf(TerminalManagerError);
    expect(rejection.reason.code).toBe('terminal-limit');
    expect(manager.list(alice)).toHaveLength(8);
  });

  it('replays retained output, reports truncation, and transfers attachment ownership', async () => {
    const pty = new FakePty();
    const manager = new TerminalManager({
      spawnPty: () => pty,
      replayBytes: 4,
    });
    const alice = principal('alice');
    const created = await manager.create(alice, {
      requestId: 'create-1',
      requestedInitialWorkingDirectory: projectPath,
    });
    const terminalId = created.terminal.terminalId;
    pty.emitData('ab');
    pty.emitData('cd');
    pty.emitData('ef');

    const firstPeer = peer('socket-1');
    manager.attach(alice, firstPeer, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });
    expect(firstPeer.messages[0]).toEqual({
      type: 'terminal-replay-truncated',
      terminalId,
      firstSequence: 2,
    });
    expect(firstPeer.messages[1]).toMatchObject({
      type: 'terminal-attached',
      replay: [
        { sequence: 2, data: 'cd' },
        { sequence: 3, data: 'ef' },
      ],
    });

    const secondPeer = peer('socket-2');
    expect(() =>
      manager.attach(alice, secondPeer, {
        type: 'terminal-attach',
        terminalId,
        clientId: 'client-2',
        afterSequence: 3,
        intent: 'restore',
      }),
    ).toThrow(TerminalManagerError);
    manager.attach(alice, secondPeer, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-2',
      afterSequence: 3,
      intent: 'takeover',
    });
    expect(firstPeer.messages.at(-1)).toEqual({
      type: 'terminal-taken-over',
      terminalId,
      replacementClientId: 'client-2',
    });
    expect(firstPeer.ownedTerminalIds.has(terminalId)).toBe(false);
    expect(secondPeer.ownedTerminalIds.has(terminalId)).toBe(true);
  });

  it('restores an attachment from a replacement peer with the same client identity', async () => {
    const manager = new TerminalManager({ spawnPty: () => new FakePty() });
    const alice = principal('alice');
    const created = await manager.create(alice, {
      requestId: 'create-1',
      requestedInitialWorkingDirectory: projectPath,
    });
    const terminalId = created.terminal.terminalId;
    const priorPeer = peer('socket-1');
    const replacementPeer = peer('socket-2');
    manager.attach(alice, priorPeer, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });

    manager.attach(alice, replacementPeer, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });

    expect(priorPeer.ownedTerminalIds.has(terminalId)).toBe(false);
    expect(replacementPeer.ownedTerminalIds.has(terminalId)).toBe(true);
    expect(
      priorPeer.messages.some(
        (message) => message.type === 'terminal-taken-over',
      ),
    ).toBe(false);
    expect(replacementPeer.messages.at(-1)).toMatchObject({
      type: 'terminal-attached',
    });
  });

  it('orders input, coalesces resize, detaches without killing, and terminates idempotently', async () => {
    const pty = new FakePty();
    const manager = new TerminalManager({ spawnPty: () => pty });
    const alice = principal('alice');
    const terminal = await manager.create(alice, {
      requestId: 'create-1',
      requestedInitialWorkingDirectory: null,
    });
    const terminalId = terminal.terminal.terminalId;
    const owner = peer('socket-1');
    manager.attach(alice, owner, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });
    manager.input(alice, owner, terminalId, 'a');
    manager.input(alice, owner, terminalId, 'b');
    manager.resize(alice, owner, terminalId, 100, 30);
    manager.resize(alice, owner, terminalId, 120, 40);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ptysWritesAndResizes(pty)).toEqual(['a', 'b', '120x40']);

    manager.detachPeer(alice, owner);
    expect(pty.killCount).toBe(0);
    expect(manager.list(alice)[0].attachmentStatus).toBe('detached');
    const first = await manager.terminate(alice, terminalId, 'terminate-1');
    const repeated = await manager.terminate(alice, terminalId, 'terminate-1');
    expect(repeated).toEqual(first);
    expect(pty.killCount).toBe(1);
    expect(manager.list(alice)).toEqual([]);
  });

  it('bounds idempotency results per principal without evicting valid retries', async () => {
    const manager = new TerminalManager({
      spawnPty: () => new FakePty(),
      requestResultsPerPrincipal: 2,
      requestResultsTotal: 4,
    });
    const alice = principal('alice');
    const bob = principal('bob');

    const first = await manager.terminate(alice, 'missing-1', 'terminate-1');
    await manager.terminate(alice, 'missing-2', 'terminate-2');
    await expect(
      manager.terminate(alice, 'missing-3', 'terminate-3'),
    ).rejects.toMatchObject({
      code: 'terminal-backpressure',
      status: 429,
    });
    expect(
      await manager.terminate(alice, 'different-id', 'terminate-1'),
    ).toEqual(first);
    await expect(
      manager.terminate(bob, 'missing-1', 'terminate-1'),
    ).resolves.toMatchObject({
      success: true,
    });
  });

  it('drops queued input when attachment ownership changes before execution', async () => {
    const pty = new FakePty();
    const manager = new TerminalManager({ spawnPty: () => pty });
    const alice = principal('alice');
    const created = await manager.create(alice, {
      requestId: 'create-1',
      requestedInitialWorkingDirectory: projectPath,
    });
    const terminalId = created.terminal.terminalId;
    const originalOwner = peer('socket-1');
    const replacementOwner = peer('socket-2');
    manager.attach(alice, originalOwner, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });

    manager.input(alice, originalOwner, terminalId, 'stale');
    manager.attach(alice, replacementOwner, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-2',
      afterSequence: 0,
      intent: 'takeover',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pty.writes).toEqual([]);
  });

  it('coalesces only adjacent resizes without crossing an input boundary', async () => {
    const pty = new FakePty();
    const manager = new TerminalManager({ spawnPty: () => pty });
    const alice = principal('alice');
    const created = await manager.create(alice, {
      requestId: 'create-1',
      requestedInitialWorkingDirectory: projectPath,
    });
    const terminalId = created.terminal.terminalId;
    const owner = peer('socket-1');
    manager.attach(alice, owner, {
      type: 'terminal-attach',
      terminalId,
      clientId: 'client-1',
      afterSequence: 0,
      intent: 'restore',
    });

    manager.resize(alice, owner, terminalId, 100, 30);
    manager.input(alice, owner, terminalId, 'x');
    manager.resize(alice, owner, terminalId, 120, 40);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pty.operations).toEqual(['100x30', 'x', '120x40']);
  });

  it('kills every remaining PTY during shutdown', async () => {
    const ptys = [];
    const manager = new TerminalManager({
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    await manager.create(principal('alice'), {
      requestId: 'alice-1',
      requestedInitialWorkingDirectory: projectPath,
    });
    await manager.create(principal('bob'), {
      requestId: 'bob-1',
      requestedInitialWorkingDirectory: projectPath,
    });

    manager.shutdown();
    expect(ptys.map((pty) => pty.killCount)).toEqual([1, 1]);
  });
});

function ptysWritesAndResizes(pty) {
  return pty.operations;
}
