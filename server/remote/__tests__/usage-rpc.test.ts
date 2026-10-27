import { expect, test } from 'bun:test';
import { AgentIntegrationError, type AgentUsageReadRequest } from '@garcon/server-agent-interface';
import type { AgentUsageReport } from '@garcon/common/usage';
import { rpcContinuity } from '../transport/rpc-protocol.js';
import { rpcLane } from '../transport/rpc-routing.js';
import { remoteFixture } from './integration-fixture.js';

const WINDOW = { sinceDay: '2026-09-28', untilDay: '2026-10-27', timeZone: 'America/Los_Angeles' };

const REPORT: AgentUsageReport = {
  status: 'partial',
  buckets: [{
    day: '2026-10-26',
    model: 'synthetic-model',
    totals: { uncachedInputTokens: 12, cachedInputTokens: 3400, cacheWriteTokens: 560, outputTokens: 78, reasoningTokens: 9 },
    costUsd: 0.123456,
    categoryCostUsd: { input: 0.000012, cacheRead: 0.0034, cacheWrite: 0.0007, output: 0.119344 },
    cacheSavingsUsd: 0.0306,
    records: 4,
    unpricedRecords: 0,
    unpricedTokens: 0,
    sessions: 2,
  }],
  scannedFiles: 3,
  unreadableFiles: 1,
  malformedRecords: 0,
  distinctSessions: 2,
  pricingAsOf: '2026-10-27',
};

test('usage reads are journaled and use the bulk lane', () => {
  expect(rpcContinuity('usageHistory.read')).toBe('journaled');
  expect(rpcLane('usageHistory.read', WINDOW)).toBe('bulk');
});

for (const dialer of ['controller', 'worker'] as const) {
  test(`a usage report crosses the executor link intact (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const received: AgentUsageReadRequest[] = [];
      fixture.generations[0]!.hooks.usage = async (request) => {
        received.push(request);
        return REPORT;
      };
      const integration = await fixture.executor.getAgentIntegration('test');
      expect(integration.usageHistory).not.toBeNull();
      const report = await integration.usageHistory!.read({ ...WINDOW, signal: new AbortController().signal });
      expect(report).toEqual(REPORT);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject(WINDOW);
      expect(received[0]!.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await fixture.dispose();
    }
  });

  test(`the controller rejects a malformed usage report (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      fixture.generations[0]!.hooks.usage = async () => ({ ...REPORT, scannedFiles: -1 });
      const integration = await fixture.executor.getAgentIntegration('test');
      const failure = await integration.usageHistory!.read(WINDOW).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AgentIntegrationError);
      expect((failure as AgentIntegrationError).code).toBe('PROVIDER_FAILURE');
    } finally {
      await fixture.dispose();
    }
  });
}
