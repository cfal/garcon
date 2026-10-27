import { expect, test } from 'bun:test';
import { AgentIntegrationError, type AgentUsageHistory, type AgentUsageReadRequest } from '@garcon/server-agent-interface';
import type { AgentUsageReport } from '../../../../common/usage.js';
import { DomainError } from '../../../common/domain-error.js';
import { UsageService, type UsageExecutors } from '../usage-service.js';

const WINDOW = { sinceDay: '2026-10-21', untilDay: '2026-10-27', timeZone: 'UTC' };

function report(overrides: Partial<AgentUsageReport> = {}): AgentUsageReport {
  return {
    status: 'ok',
    buckets: [{
      day: '2026-10-26', model: 'synthetic-model',
      totals: { uncachedInputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 0 },
      costUsd: 1.5, categoryCostUsd: { input: 0.1, cacheRead: 0.2, cacheWrite: 0.3, output: 0.9 }, cacheSavingsUsd: 0.4,
      records: 2, unpricedRecords: 0, unpricedTokens: 0, sessions: 1,
    }],
    scannedFiles: 1, unreadableFiles: 0, malformedRecords: 0, distinctSessions: 1, pricingAsOf: '2026-10-27',
    ...overrides,
  };
}

function executors(sources: Record<string, AgentUsageHistory | null>, seen: string[] = []): UsageExecutors {
  return {
    integrationsFor(executorId) {
      seen.push(executorId);
      if (executorId === 'offline') throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true);
      return { list: () => Object.entries(sources).map(([id, usageHistory]) => ({ descriptor: { id }, usageHistory })) };
    },
  };
}

test('merges each integration report on the requested executor', async () => {
  const requests: AgentUsageReadRequest[] = [];
  const seen: string[] = [];
  const service = new UsageService(executors({
    claude: { read: async (request) => { requests.push(request); return report(); } },
    codex: { read: async () => report({ status: 'missing', buckets: [], scannedFiles: 0, distinctSessions: 0, pricingAsOf: '2026-10-20' }) },
    shell: null,
  }, seen));
  const summary = await service.readSummary('remote-executor', WINDOW, { timeoutMs: 5_000 });
  expect(seen).toEqual(['remote-executor']);
  expect(summary).toMatchObject({ executorId: 'remote-executor', ...WINDOW, pricingAsOf: '2026-10-27' });
  expect(summary.agents.map((agent) => [agent.agentId, agent.status, agent.buckets.length])).toEqual([
    ['claude', 'ok', 1],
    ['codex', 'missing', 0],
  ]);
  expect(summary.agents[0]).not.toHaveProperty('pricingAsOf');
  expect(requests[0]).toMatchObject(WINDOW);
  expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
});

test('reports a failed integration read without failing the summary', async () => {
  const service = new UsageService(executors({
    claude: { read: async () => { throw new AgentIntegrationError('PROVIDER_FAILURE', 'Synthetic read failure', false); } },
    codex: { read: async () => report() },
  }));
  const summary = await service.readSummary('local', WINDOW, { timeoutMs: 5_000 });
  expect(summary.agents[0]).toMatchObject({ agentId: 'claude', status: 'failed', message: 'Synthetic read failure', buckets: [] });
  expect(summary.agents[1]).toMatchObject({ agentId: 'codex', status: 'ok' });
});

test('bounds slow reads and reports them as timed out', async () => {
  const service = new UsageService(executors({
    claude: { read: ({ signal }) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) },
  }));
  const summary = await service.readSummary('local', WINDOW, { timeoutMs: 20 });
  expect(summary.agents[0]).toMatchObject({ status: 'failed', message: 'Reading usage took too long' });
});

test('propagates caller cancellation and executor unavailability', async () => {
  const caller = new AbortController();
  const service = new UsageService(executors({
    claude: { read: ({ signal }) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))) },
  }));
  const pending = service.readSummary('local', WINDOW, { signal: caller.signal, timeoutMs: 5_000 });
  caller.abort(new Error('caller left'));
  expect(pending).rejects.toThrow('caller left');
  expect(service.readSummary('offline', WINDOW, { timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
});
