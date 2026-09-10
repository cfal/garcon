import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalWorkspaceTerminalService } from '../local-workspace-terminals.js';
import { resolveRealWithinBase } from '../../lib/path-boundary.js';
import { WorkspaceTerminalError } from '../../execution-nodes/workspace-terminals.js';

const principal = { key: 'local', mode: 'local', username: 'local', expiresAtMs: null };
const services = [];
let projectPath;

function pty() {
  return {
    writes: [],
    killCount: 0,
    dataListeners: [],
    exitListeners: [],
    onData(listener) {
      this.dataListeners.push(listener);
      return { dispose() {} };
    },
    onExit(listener) {
      this.exitListeners.push(listener);
      return { dispose() {} };
    },
    write(data) {
      this.writes.push(data);
    },
    resize() {},
    kill() {
      this.killCount += 1;
      for (const listener of this.exitListeners) listener({ exitCode: 0 });
    },
  };
}

function service(options) {
  const owner = new LocalWorkspaceTerminalService({
    projectBasePath: projectPath,
    assertProjectPathAllowed: (target) => resolveRealWithinBase(projectPath, target),
    shell: '/bin/sh',
    environment: {},
    ...options,
  });
  services.push(owner);
  return owner;
}

function peer(connectionId, sendTerminalMessage = () => {}) {
  const lifetime = new AbortController();
  return { connectionId, signal: lifetime.signal, lifetime, sendTerminalMessage };
}

function expectTerminalError(operation, code) {
  let thrown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkspaceTerminalError);
  expect(thrown).toMatchObject({ code });
}

beforeEach(async () => {
  projectPath = await fs.mkdtemp(path.join(os.homedir(), 'garcon-terminal-owner-'));
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((owner) => owner.shutdown()));
  await fs.rm(projectPath, { recursive: true, force: true });
});

test('shutdown fences creation held in directory validation and its queued successor', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const originalStat = fs.stat;
  const heldStat = spyOn(fs, 'stat').mockImplementation(async (target, ...args) => {
    if (target === projectPath) {
      entered.resolve();
      await release.promise;
    }
    return originalStat.call(fs, target, ...args);
  });
  const spawned = [];
  const owner = service({
    spawnPty: () => {
      const child = pty();
      spawned.push(child);
      return child;
    },
  });
  const first = owner.create(principal, {
    requestId: 'first',
    requestedInitialWorkingDirectory: projectPath,
  });
  const second = owner.create(principal, {
    requestId: 'second',
    requestedInitialWorkingDirectory: projectPath,
  });
  const outcomes = Promise.allSettled([first, second]);
  try {
    await Promise.race([
      entered.promise,
      first.then(() => {
        throw new Error('Directory validation bypassed its barrier');
      }),
    ]);
    const stopped = owner.shutdown();
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    await stopped;
    expect(spawned).toEqual([]);
    expectTerminalError(() => owner.list(principal), 'terminal-internal');
  } finally {
    release.resolve();
    await outcomes;
    heldStat.mockRestore();
  }
});

test('shutdown invalidates queued input before killing the PTY', async () => {
  const child = pty();
  const owner = service({ spawnPty: () => child });
  const { terminal } = await owner.create(principal, {
    requestId: 'create',
    requestedInitialWorkingDirectory: null,
  });
  const peer = {
    connectionId: 'synthetic-socket',
    signal: new AbortController().signal,
    sendTerminalMessage() {},
  };
  owner.attach(principal, peer, {
    type: 'terminal-attach',
    terminalId: terminal.terminalId,
    clientId: 'synthetic-tab',
    intent: 'restore',
    afterSequence: 0,
  });
  owner.input(principal, peer, terminal.terminalId, 'must-not-run');
  await owner.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  expect(child.killCount).toBe(1);
  expect(child.writes).toEqual([]);
});

test.each(['shutdown', 'authorization-expiry'])(
  'kills a late asynchronous spawn after %s without wiring or publication',
  async (condition) => {
    let now = 0;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const child = pty();
    const owner = service({
      now: () => now,
      spawnPty: async () => {
        entered.resolve();
        return release.promise;
      },
    });
    const creating = owner.create(
      { key: 'alice', expiresAtMs: 1 },
      { requestId: 'late-spawn', requestedInitialWorkingDirectory: null },
    );
    const outcome = creating.then(
      () => 'created',
      (error) => error.code,
    );
    let stopping;
    try {
      await entered.promise;
      if (condition === 'shutdown') stopping = owner.shutdown();
      else now = 1;
      release.resolve(child);
      expect(await outcome).toBe(
        condition === 'shutdown' ? 'terminal-internal' : 'terminal-auth-expired',
      );
      await stopping;
      expect(child.killCount).toBe(1);
      expect(child.dataListeners).toEqual([]);
      expect(child.exitListeners).toEqual([]);
      if (condition === 'shutdown')
        expectTerminalError(() => owner.list(principal), 'terminal-internal');
      else expect(owner.list({ key: 'alice', expiresAtMs: null })).toEqual([]);
    } finally {
      release.resolve(child);
      await outcome;
    }
  },
);

test('closes create admission synchronously and returns the same shutdown settlement', async () => {
  const authorize = mock(async (target) => target);
  const spawn = mock(() => pty());
  const owner = service({ assertProjectPathAllowed: authorize, spawnPty: spawn });
  const stopping = owner.shutdown();
  await expect(
    owner.create(principal, { requestId: 'after-stop', requestedInitialWorkingDirectory: null }),
  ).rejects.toMatchObject({ code: 'terminal-internal' });
  expect(owner.shutdown()).toBe(stopping);
  await stopping;
  expect(authorize).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

test('refuses terminal listing for an expired principal', async () => {
  let now = 0;
  const owner = service({ now: () => now, spawnPty: () => pty() });
  const caller = { key: 'alice', expiresAtMs: 1 };
  await owner.create(caller, { requestId: 'create', requestedInitialWorkingDirectory: null });
  expect(owner.list(caller)).toHaveLength(1);
  now = 1;
  expectTerminalError(() => owner.list(caller), 'terminal-auth-expired');
});

test('captures request, principal, shell, and environment before asynchronous authorization', async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const environment = { SYNTHETIC_TERMINAL: 'admitted', TERM: 'caller-value' };
  const calls = [];
  const options = {
    environment,
    shell: 'synthetic-shell',
    now: () => 0,
    assertProjectPathAllowed: async (target) => {
      entered.resolve();
      await release.promise;
      return resolveRealWithinBase(projectPath, target);
    },
    spawnPty: (shell, args, configuration) => {
      calls.push({ shell, args, configuration });
      return pty();
    },
  };
  const owner = service(options);
  const caller = { key: 'alice', expiresAtMs: 1 };
  const request = { requestId: 'admitted', requestedInitialWorkingDirectory: projectPath };
  const creating = owner.create(caller, request);
  try {
    await entered.promise;
    caller.key = 'bob';
    caller.expiresAtMs = 0;
    request.requestId = 'changed';
    request.requestedInitialWorkingDirectory = '/outside';
    options.shell = 'changed-shell';
    environment.SYNTHETIC_TERMINAL = 'changed';
    release.resolve();
    const result = await creating;
    expect(calls).toEqual([
      {
        shell: 'synthetic-shell',
        args: [],
        configuration: {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: projectPath,
          env: {
            SYNTHETIC_TERMINAL: 'admitted',
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        },
      },
    ]);
    expect(
      await owner.create(
        { key: 'alice', expiresAtMs: 1 },
        { requestId: 'admitted', requestedInitialWorkingDirectory: null },
      ),
    ).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(owner.list({ key: 'bob', expiresAtMs: null })).toEqual([]);
  } finally {
    release.resolve();
    await creating.catch(() => {});
  }
});

test('submits attach and input in the same turn, and rejects effects from an aborted peer', async () => {
  const child = pty();
  const owner = service({ spawnPty: () => child });
  const { terminal } = await owner.create(principal, {
    requestId: 'create',
    requestedInitialWorkingDirectory: null,
  });
  const client = peer('client');
  expect(
    owner.attach(principal, client, {
      type: 'terminal-attach',
      terminalId: terminal.terminalId,
      clientId: 'tab',
      afterSequence: 0,
      intent: 'restore',
    }),
  ).toBeUndefined();
  expect(owner.input(principal, client, terminal.terminalId, 'first')).toBeUndefined();
  await new Promise((resolve) => setImmediate(resolve));
  expect(child.writes).toEqual(['first']);
  owner.input(principal, client, terminal.terminalId, 'stale');
  client.lifetime.abort();
  await new Promise((resolve) => setImmediate(resolve));
  expect(child.writes).toEqual(['first']);
  expect(() => owner.input(principal, client, terminal.terminalId, 'closed')).toThrow();
});

test('reports an aborted peer through the domain error contract for every stream control', async () => {
  const child = pty();
  const owner = service({ spawnPty: () => child });
  const { terminal } = await owner.create(principal, {
    requestId: 'create',
    requestedInitialWorkingDirectory: null,
  });
  const client = peer('client');
  const request = {
    type: 'terminal-attach',
    terminalId: terminal.terminalId,
    clientId: 'tab',
    afterSequence: 0,
    intent: 'restore',
  };
  owner.attach(principal, client, request);
  client.lifetime.abort(new Error('Synthetic connection failure'));
  for (const control of [
    () => owner.attach(principal, client, request),
    () => owner.input(principal, client, terminal.terminalId, 'closed'),
    () => owner.resize(principal, client, terminal.terminalId, 100, 30),
  ]) {
    expectTerminalError(control, 'terminal-not-attached');
  }
  expect(child.writes).toEqual([]);
});

test('drops queued input and resize when the captured attachment expires before their effects', async () => {
  let now = 0;
  const child = pty();
  const resize = spyOn(child, 'resize');
  const owner = service({ now: () => now, spawnPty: () => child });
  const caller = { key: 'alice', expiresAtMs: 1 };
  const { terminal } = await owner.create(caller, {
    requestId: 'create',
    requestedInitialWorkingDirectory: null,
  });
  const client = peer('client');
  owner.attach(caller, client, {
    type: 'terminal-attach',
    terminalId: terminal.terminalId,
    clientId: 'tab',
    afterSequence: 0,
    intent: 'restore',
  });
  owner.input(caller, client, terminal.terminalId, 'expired');
  owner.resize(caller, client, terminal.terminalId, 100, 30);
  caller.expiresAtMs = 10;
  now = 1;
  await new Promise((resolve) => setImmediate(resolve));
  expect(client.signal.aborted).toBe(false);
  expect(child.writes).toEqual([]);
  expect(resize).not.toHaveBeenCalled();
});

test.each(['terminal-taken-over', 'terminal-replay-truncated', 'terminal-attached'])(
  'reentrant detach during %s wins over attach',
  async (event) => {
    const child = pty();
    const owner = service({ spawnPty: () => child, replayBytes: 1 });
    const { terminal } = await owner.create(principal, {
      requestId: 'create',
      requestedInitialWorkingDirectory: null,
    });
    const messages = [];
    let replacement;
    const receive = (message) => {
      messages.push(message);
      if (message.type === event) owner.detachTerminal(principal, replacement, terminal.terminalId);
    };
    const original = peer('original', receive);
    replacement = peer('replacement', receive);
    owner.attach(principal, original, {
      type: 'terminal-attach',
      terminalId: terminal.terminalId,
      clientId: 'old-tab',
      afterSequence: 0,
      intent: 'restore',
    });
    for (const data of ['a', 'b', 'c']) child.dataListeners.forEach((listener) => listener(data));
    messages.length = 0;
    owner.attach(principal, replacement, {
      type: 'terminal-attach',
      terminalId: terminal.terminalId,
      clientId: 'new-tab',
      afterSequence: 0,
      intent: 'takeover',
    });
    expect(owner.list(principal)[0].attachmentStatus).toBe('detached');
    expect(() => owner.input(principal, replacement, terminal.terminalId, 'stale')).toThrow(
      WorkspaceTerminalError,
    );
    expect(messages.at(-1).type).toBe(event);
  },
);

test('does not publish the synchronous synthetic exit emitted by PTY kill', async () => {
  const child = pty();
  const owner = service({ spawnPty: () => child });
  const { terminal } = await owner.create(principal, {
    requestId: 'create',
    requestedInitialWorkingDirectory: null,
  });
  const messages = [];
  const client = peer('client', (message) => messages.push(message));
  owner.attach(principal, client, {
    type: 'terminal-attach',
    terminalId: terminal.terminalId,
    clientId: 'tab',
    afterSequence: 0,
    intent: 'restore',
  });
  messages.length = 0;
  await owner.terminate(principal, terminal.terminalId, 'terminate');
  expect(messages).toEqual([{ type: 'terminal-terminated', terminalId: terminal.terminalId }]);
  expect(child.killCount).toBe(1);
});

test('an aborted peer receives no output, status, takeover, or termination notifications', async () => {
  const child = pty();
  const owner = service({ spawnPty: () => child });
  const { terminal } = await owner.create(principal, {
    requestId: 'create',
    requestedInitialWorkingDirectory: null,
  });
  const messages = [];
  const client = peer('aborted', (message) => messages.push(message));
  owner.attach(principal, client, {
    type: 'terminal-attach',
    terminalId: terminal.terminalId,
    clientId: 'old-tab',
    afterSequence: 0,
    intent: 'restore',
  });
  messages.length = 0;
  client.lifetime.abort();
  child.dataListeners.forEach((listener) => listener('retained'));
  owner.rename(principal, terminal.terminalId, 'Renamed');
  const replacementMessages = [];
  owner.attach(
    principal,
    peer('replacement', (message) => replacementMessages.push(message)),
    {
      type: 'terminal-attach',
      terminalId: terminal.terminalId,
      clientId: 'new-tab',
      afterSequence: 0,
      intent: 'takeover',
    },
  );
  expect(replacementMessages).toEqual([
    expect.objectContaining({
      type: 'terminal-attached',
      replay: [{ sequence: 1, data: 'retained' }],
    }),
  ]);
  child.exitListeners.forEach((listener) => listener({ exitCode: 0 }));
  await owner.terminate(principal, terminal.terminalId, 'terminate');
  expect(messages).toEqual([]);
});
