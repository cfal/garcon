import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilesService } from '../files/service.js';
import { RuntimeMaintenance } from '../maintenance.js';
import { resolveRealWithinBase } from '../../common/path-boundary.js';

test('Files mutations exclude removal until settled and refuse new writes during removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-files-'));
  const guard = new RuntimeMaintenance();
  const entered = Promise.withResolvers<void>(); const held = Promise.withResolvers<void>();
  const service = new FilesService({ executorId: 'synthetic', projectBasePath: root,
    reserveMutation: () => guard.reserveMutation(), async resolveSaveTarget(...args) {
      entered.resolve(); await held.promise; return resolveRealWithinBase(...args);
    } });
  try {
    await writeFile(join(root, 'file.txt'), 'original');
    const target = { projectPath: root, filePath: 'file.txt' };
    const request = { ...target, content: 'acknowledged', expectedRevision: (await service.read(target)).revision, conflictResolution: 'overwrite' as const };
    const saving = service.save(request); await entered.promise;
    await expect(guard.remove([], () => () => {}, async () => { throw new Error('Must not remove'); }))
      .rejects.toMatchObject({ code: 'GIT_SERVICE_BUSY' });
    held.resolve(); expect((await saving).success).toBe(true);
    await guard.remove([], () => () => {}, async () => {
      await expect(service.save({ ...request, content: 'must not write' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      await expect(service.createDirectory({ parentPath: root, name: 'must-not-create' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('acknowledged');
      await expect(access(join(root, 'must-not-create'))).rejects.toThrow();
    });
    expect((await service.save(request)).success).toBe(true);
  } finally { held.resolve(); await rm(root, { recursive: true, force: true }); }
});
