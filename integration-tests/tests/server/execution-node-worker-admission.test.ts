import { expect, test } from 'bun:test';
import { startWorkerSessionFixture } from '../../support/worker-session-fixture.js';

test.each(['claude', 'codex', 'cursor', 'factory', 'pi', 'opencode', 'amp'])('%s production worker refuses unattested turn execution without exhausting admission', async (agentId) => {
  const instanceId = 'synthetic-instance';
  const f = await startWorkerSessionFixture([{ id: instanceId, agentId, environment: {} }]);
  try {
    expect(f.manifests[0]!.facets.execution).toBeNull();
    const stream = await f.install(instanceId, 'synthetic-stream');
    await f.recover();
    const configuration = { model: 'synthetic-model', settings: null, endpoint: null };
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await f.prepare(instanceId, '1789000000000001', `synthetic-run-${attempt}`, configuration))
        .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    }
    expect(await f.prepare(instanceId, '1789000000000002', 'synthetic-sibling-run', configuration))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(await f.receipt(instanceId, { ...f.session, operationId: 'synthetic-unissued-operation' }))
      .toEqual({ kind: 'status', receipt: null });
    expect(stream.frames).toEqual([]);
    await f.reconnect();
    await f.recover();
    await f.retire(stream);
    expect((await f.install(instanceId, 'synthetic-successor-stream')).retired).toBe(false);
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
}, 30_000);
