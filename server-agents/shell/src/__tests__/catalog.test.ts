import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverShells, requireShell } from '../catalog.js';

test.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('discovers only supported shell families', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shell-catalog-'));
  try {
    for (const family of ['sh', 'bash', 'zsh', 'fish', 'pwsh']) {
      await symlink(process.execPath, join(root, family));
    }
    const host = { environment: { get: (key: string) => key === 'PATH' ? root : undefined } };
    expect(discoverShells(host)).toEqual((['sh', 'bash', 'zsh', 'fish'] as const).map(family => ({
      family, executable: join(root, family),
    })));
    expect(() => requireShell(host, 'pwsh')).toThrow('Selected shell is unavailable: pwsh');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
