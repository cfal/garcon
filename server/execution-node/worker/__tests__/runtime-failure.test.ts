import { expect, mock, test } from 'bun:test';
import { NodeWorkerBootstrap, type NodeWorkerRuntime, type NodeWorkerRuntimeContext } from '../bootstrap.js';
import { NodeWorkerLifeline } from '../lifeline.js';
import { serializeNodeWorkerParent } from '../protocol.js';
import { configureMessage, manifest, tick } from './lifecycle-fixture.js';

test.each(['initializing', 'ready'] as const)('runtime authority loss while %s closes the bootstrap and reports failure once', async (phase) => {
  const lifeline = new NodeWorkerLifeline({ clock: { read: () => ({ elapsedMs: 0, discontinuity: false }) },
    scheduleTimeout: () => ({ cancel() {} }), retired() {} });
  const started = Promise.withResolvers<NodeWorkerRuntime>();
  const start = mock((_context: NodeWorkerRuntimeContext) => started.promise);
  const runtime = { manifests: [manifest()], async control() {}, application() {}, close: mock(async () => {}) } satisfies NodeWorkerRuntime;
  const failed = mock(() => {});
  const bootstrap = new NodeWorkerBootstrap({ role: 'session', lifeline, start, failed, async send() {} });
  try {
    bootstrap.receive(serializeNodeWorkerParent(configureMessage()));
    if (phase === 'ready') { started.resolve(runtime); await tick(); }
    start.mock.calls[0]![0].authority.retire();
    await tick();
    expect(lifeline.signal.aborted).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
    started.resolve(runtime);
    await bootstrap.close();
    expect(runtime.close).toHaveBeenCalledTimes(1);
  } finally { started.resolve(runtime); await bootstrap.close(); }
});
