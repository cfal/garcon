import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveCodexProtocolProbe } from '../../support/live-codex-protocol-probe.js';

describe('live Codex protocol probe', () => {
  test('observes approval methods without persisting request details', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-codex-probe-'));
    try {
      const fakeBinary = join(root, 'fake-codex');
      await writeFile(fakeBinary, `#!/usr/bin/env bun
console.log(JSON.stringify({
  id: 'private-request-id',
  method: 'item/commandExecution/requestApproval',
  params: {
    command: 'private command',
    cwd: '/private/path',
  },
}));
console.log(JSON.stringify({ method: 'unrelated', params: { content: 'private output' } }));
`, { mode: 0o700 });
      const environment = { GARCON_CODEX_CLI: fakeBinary };
      const probe = createLiveCodexProtocolProbe(environment);
      await probe.prepareWorkspace({
        root,
        config: join(root, 'config'),
        workspace: join(root, 'workspace'),
        project: join(root, 'project'),
        home: join(root, 'home'),
      });

      const child = Bun.spawn([environment.GARCON_CODEX_CLI], {
        env: { ...process.env, ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toContain('private command');

      expect(await probe.waitForApprovalRequest()).toBe(
        'item/commandExecution/requestApproval',
      );
      expect(await probe.readApprovalRequests()).toEqual([
        'item/commandExecution/requestApproval',
      ]);
      const persistedProbeData = await readFile(join(root, 'codex-approval-requests'), 'utf8');
      expect(persistedProbeData).not.toContain('private-request-id');
      expect(persistedProbeData).not.toContain('private command');
      expect(persistedProbeData).not.toContain('/private/path');
      expect(persistedProbeData).not.toContain('private output');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
