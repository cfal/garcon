import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveClaudeProtocolProbe } from '../../support/live-claude-protocol-probe.js';

describe('live Claude protocol probe', () => {
  test('observes only correlated lifecycle identities while forwarding output', async () => {
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

      expect(await probe.waitForInputStarted()).toBe(commandUuid);
      expect(await probe.waitForTerminal()).toEqual({
        reason: 'aborted_tools',
        userMessageUuid: commandUuid,
      });
      expect(await probe.waitForTerminal(2)).toEqual({
        reason: 'aborted_streaming',
        userMessageUuid: null,
      });
      const persistedProbeData = [
        await readFile(join(root, 'claude-started-inputs'), 'utf8'),
        await readFile(join(root, 'claude-terminal-results'), 'utf8'),
      ].join('\n');
      expect(persistedProbeData).not.toContain('private output');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
