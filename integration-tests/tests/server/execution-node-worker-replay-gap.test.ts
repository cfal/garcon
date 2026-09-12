import { expect, test } from 'bun:test';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';
import type { ProviderConfigurationRequest } from '../../../server/execution-nodes/provider-configuration.js';
import { FakeClaudeModel, claudeText } from '../../support/fake-claude-model.js';
import { startWorkerSessionFixture } from '../../support/worker-session-fixture.js';

test('real child replay eviction retires exactly the interrupted stream and preserves sibling execution', async () => {
  const model = FakeClaudeModel.start();
  let fixture: Awaited<ReturnType<typeof startWorkerSessionFixture>> | undefined;
  const held = model.scriptHeldTurn([claudeText('界'.repeat(30_000))]);
  model.scriptTurn([claudeText('synthetic sibling completed')]);
  try {
    fixture = await startWorkerSessionFixture([{ id: 'synthetic-instance', agentId: 'direct-anthropic-compatible', environment: {} }],
      { ...DEFAULT_NODE_REPLAY, maxBytes: 1024 });
    const retiredBeforeInstall = { ...fixture.session, streamId: 'synthetic-retired-before-install' };
    await fixture.sendRetirement('synthetic-instance', retiredBeforeInstall);
    expect(await fixture.call({ method: 'install-output', instanceId: 'synthetic-instance', stream: retiredBeforeInstall }))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const first = await fixture.install('synthetic-instance', 'synthetic-first-stream');
    const second = await fixture.install('synthetic-instance', 'synthetic-second-stream');
    await fixture.recover();
    const configuration: ProviderConfigurationRequest = { model: 'synthetic-model', thinkingMode: 'none', settings: null,
      endpoint: { credential: 'synthetic-credential', selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint',
        providerLabel: 'Synthetic', protocol: 'anthropic-messages', model: 'synthetic-model', isLocal: true,
        baseUrl: model.baseUrl, capabilities: null, headers: {} } } };
    const ticket = await fixture.start(first, '1789000000000001', 'synthetic-first-run', configuration);
    await held.requested; await fixture.reconnect(); held.release();
    let phase: string | null = null;
    for (let attempt = 0; attempt < 128; attempt++) {
      const result = await fixture.receipt(first.instanceId, ticket.identity);
      if (result.kind === 'status') phase = result.receipt?.phase ?? null;
      if (phase === 'ended') break;
    }
    expect(phase).toBe('ended');
    const ranges = await fixture.recover();
    expect(ranges.some((range) => range.type === 'node-replay-gap' && range.stream.streamId === first.stream.streamId)).toBe(true);
    expect(first.retired).toBe(true); expect(first.failures).toHaveLength(1);
    await fixture.recover();
    await fixture.start(second, '1789000000000002', 'synthetic-second-run', configuration);
    expect((await fixture.waitFor(second, (frame) => frame.event.type === 'run-ended')).event).toMatchObject({ outcome: 'finished' });
    expect(second.frames.some((frame) => frame.event.type === 'rows'
      && frame.event.rows.some(({ message }) => message.type === 'assistant-message' && message.content === 'synthetic sibling completed'))).toBe(true);
    expect(second.failures).toEqual([]); expect(fixture.failures).toEqual([]);
    expect(model.requests()).toHaveLength(2); model.assertSettled();
  } finally { held.release(); await fixture?.close(); model.stop(); }
}, 45_000);
