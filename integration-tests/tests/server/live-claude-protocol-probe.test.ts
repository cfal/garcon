import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveClaudeProtocolProbe } from '../../support/live-claude-protocol-probe.js';

describe('live Claude protocol probe', () => {
  test('observes lifecycle and context controls without retaining message content or settings values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-claude-probe-'));
    try {
      const commandUuid = crypto.randomUUID();
      const fakeBinary = join(root, 'fake-claude');
      await writeFile(fakeBinary, `#!/usr/bin/env bun
console.log(JSON.stringify({
  type: 'command_lifecycle',
  state: 'started',
  command_uuid: ${JSON.stringify(commandUuid)},
}));
console.log(JSON.stringify({ type: 'assistant', message: { content: 'private output' } }));
console.log(JSON.stringify({
  type: 'result',
  terminal_reason: 'aborted_tools',
  user_message_uuid: ${JSON.stringify(commandUuid)},
}));
console.log(JSON.stringify({
  type: 'result',
  terminal_reason: 'aborted_streaming',
}));
console.log(JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    response: { cancelled: ['private-uuid'], still_queued: [] },
  },
}));
console.log(JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    response: { sources: [{ source: 'flagSettings', settings: { env: { SYNTHETIC_KEY: 'private-value' } } }] },
  },
}));
console.log(JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    response: { model: 'custom[1m]', rawMaxTokens: 850000, autocompactSource: 'env' },
  },
}));
console.log(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }));
`, { mode: 0o700 });
      const environment = { CLAUDE_BINARY: fakeBinary };
      const probe = createLiveClaudeProtocolProbe(environment);
      await probe.prepareWorkspace({
        root,
        config: join(root, 'config'),
        workspace: join(root, 'workspace'),
        project: join(root, 'project'),
        home: join(root, 'home'),
      });

      const child = Bun.spawn([environment.CLAUDE_BINARY], {
        env: { ...process.env, ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toContain('private output');
      expect(output).toContain('private-value');
      expect(output).toContain('"rawMaxTokens":850000');

      expect(await probe.waitForInputStarted()).toBe(commandUuid);
      expect(await probe.waitForTerminal()).toEqual({
        reason: 'aborted_tools',
        userMessageUuid: commandUuid,
      });
      expect(await probe.waitForTerminal(2)).toEqual({
        reason: 'aborted_streaming',
        userMessageUuid: null,
      });
      expect(await probe.waitForInterruptReceipt()).toEqual({
        cancelledCount: 1,
        stillQueuedCount: 0,
      });
      expect(await probe.readInterruptReceipts()).toEqual([{
        cancelledCount: 1,
        stillQueuedCount: 0,
      }]);
      expect(await probe.readContextObservations()).toEqual([
        { type: 'flag-environment', processId: expect.any(Number), keys: ['SYNTHETIC_KEY'] },
        { type: 'context-window', processId: expect.any(Number), model: 'custom[1m]', source: 'env', window: 850000 },
        { type: 'compact-boundary', processId: expect.any(Number) },
      ]);
      const persistedProbeData = [
        await readFile(join(root, 'claude-started-inputs'), 'utf8'),
        await readFile(join(root, 'claude-terminal-results'), 'utf8'),
        await readFile(join(root, 'claude-interrupt-receipts'), 'utf8'),
        await readFile(join(root, 'claude-context-observations'), 'utf8'),
      ].join('\n');
      expect(persistedProbeData).not.toContain('private output');
      expect(persistedProbeData).not.toContain('private-uuid');
      expect(persistedProbeData).not.toContain('private-value');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
