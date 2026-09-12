import { expect, test } from 'bun:test';
import { ClaudeProcessTransport } from '../../../server-agents/claude/src/agents/claude/cli-process-transport.js';

test.skipIf(process.platform !== 'linux')('Claude write timeout settles backpressured Bun stdin and a SIGTERM-ignoring peer', async () => {
  const child = Bun.spawn([process.execPath, '-e', `
    process.on('SIGTERM', () => console.log(JSON.stringify({ kind: 'ignored-term' })));
    console.log(JSON.stringify({ kind: 'ready' }));
    setInterval(() => {}, 1000);
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let ready!: () => void;
  let ignoredTerm!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const termReceipt = new Promise<void>(resolve => { ignoredTerm = resolve; });
  let exited = false;
  void child.exited.then(() => { exited = true; });
  const failures: string[] = [];
  const transport = new ClaudeProcessTransport<{ kind: string }>({
    process: child,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    sessionId: 'synthetic-backpressure',
    onMessage: message => {
      if (message.kind === 'ready') ready();
      if (message.kind === 'ignored-term') ignoredTerm();
    },
    onFailure: failure => failures.push(failure.message),
    onEof() {},
    onExit() {},
  });
  try {
    await readiness;
    child.kill('SIGTERM');
    await termReceipt;
    expect(exited).toBe(false);
    expect(child.killed).toBe(false);

    await expect(transport.writeLine('x'.repeat(8 * 1024 * 1024), { attemptTimeoutMs: 25 }))
      .rejects.toThrow('Claude CLI stdin write timed out');
    expect(exited).toBe(true);
    expect(failures).toEqual(['Claude CLI stdin write timed out']);
    await transport.retire();
    await expect(transport.writeLine('synthetic successor')).rejects.toThrow('not writable');
  } finally {
    if (!exited) child.kill('SIGKILL');
    await child.exited;
    await transport.retire();
  }
}, 10_000);
