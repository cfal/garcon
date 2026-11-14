import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import type { DirectorySelectionResult } from '../../../common/file-contracts.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const backend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`system directory selection stays on its captured executor (${backend})`, async () => {
    await withIntegrationFixture(`directory-selection-${backend}`, async (fixture) => {
      const { client } = fixture;
      const url = `/api/v1/files/select-directory?${new URLSearchParams({ executorId: client.executorId })}`;
      expect(await client.post<DirectorySelectionResult>(url, { directoryPath: fixture.executionDirs.project }))
        .toEqual({ status: 'unsupported' });
      expect(await rejectionOf(client.post(url, { directoryPath: fixture.executionDirs.project, executorId: 'local' })))
        .toMatchObject({ status: 400 });
      if (client.executorId !== 'local') {
        expect(await rejectionOf(client.post(url, { directoryPath: fixture.dirs.project })))
          .toMatchObject({ status: 403 });
      }
      console.info(`Directory selection assertions completed: ${backend}`);
    }, { executionBackend: backend, projectRoots: 'separate', serverEnvironment: { CI: '1' } });
  }, 60_000);
}
