import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { ExecutionRuntime } from '../../execution-runtime.js';
import { descriptorPathsDirectory } from '../directory-creation.js';
import { FilesService } from '../service.js';

// Tests that create directories are gated on this detection. Without this
// check, a detection that broke on Linux would skip them all and still pass.
test.skipIf(process.platform !== 'linux' || !existsSync('/proc/self/fd'))('detects descriptor paths on Linux with procfs', () => {
  expect(descriptorPathsDirectory()).toBe('/proc/self/fd');
});

test('an executor advertises exactly what its file service can do', async () => {
  for (const descriptorPaths of [undefined, null, '/garcon-injected-descriptor-paths'] as const) {
    const service = new FilesService({ executorId: 'synthetic-executor', projectBasePath: '/', descriptorPaths });
    expect(service.canCreateDirectories).toBe(descriptorPaths === undefined ? descriptorPathsDirectory() !== null : descriptorPaths !== null);
  }
  const runtime = new ExecutionRuntime({ id: 'synthetic-executor', workspaceDir: '/', projectBasePath: '/', integrations: [], resolveCredential: async () => null });
  try {
    expect((await runtime.getInfo()).services.directoryCreation).toBe(descriptorPathsDirectory() !== null);
  } finally { await runtime.dispose(); }
});
