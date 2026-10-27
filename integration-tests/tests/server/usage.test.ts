import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseUsageSummary, type UsageSummary } from '../../../common/usage.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const DAY_MS = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const window = () => ({ sinceDay: day(-6), untilDay: day(0), timeZone: 'UTC' });

interface SeededUsage {
  readonly claudeModel: string;
  readonly codexModel: string;
}

// One Claude response written as two content-block lines, and one Codex request.
async function seedTranscripts(home: string, seed: SeededUsage): Promise<void> {
  const at = `${day(-1)}T12:00:00.000Z`;
  const claudeDir = join(home, '.claude', 'projects', '-workspace-synthetic');
  await mkdir(claudeDir, { recursive: true });
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 2_000 };
  const claudeLines = ['text', 'tool_use'].map((type) => JSON.stringify({
    type: 'assistant', timestamp: at, sessionId: '00000000-0000-4000-8000-00000000c1a0', requestId: 'req_synthetic',
    message: { id: 'msg_synthetic', role: 'assistant', model: seed.claudeModel, content: [{ type }], usage },
  }));
  await writeFile(join(claudeDir, '00000000-0000-4000-8000-00000000c1a0.jsonl'), `${claudeLines.join('\n')}\n`);

  const codexDir = join(home, '.codex', 'sessions', ...day(-1).split('-'));
  await mkdir(codexDir, { recursive: true });
  const last = { input_tokens: 5_000, cached_input_tokens: 4_000, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 5_100 };
  const codexLines = [
    { type: 'session_meta', timestamp: at, payload: { id: '00000000-0000-4000-8000-00000000c0de' } },
    { type: 'turn_context', timestamp: at, payload: { model: seed.codexModel } },
    { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: last } } },
  ].map((line) => JSON.stringify(line));
  await writeFile(join(codexDir, 'rollout-synthetic-00000000-0000-4000-8000-00000000c0de.jsonl'), `${codexLines.join('\n')}\n`);
}

function agent(summary: UsageSummary, agentId: string) {
  const entry = summary.agents.find((candidate) => candidate.agentId === agentId);
  if (!entry) throw new Error(`Missing ${agentId} usage`);
  return entry;
}

const EXECUTOR_USAGE = { claudeModel: 'claude-sonnet-5-5', codexModel: 'gpt-6.1-terra' };
const CONTROLLER_USAGE = { claudeModel: 'claude-haiku-5-5', codexModel: 'gpt-6-luna' };

for (const backend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`usage reads Claude and Codex transcripts on the selected executor (${backend})`, async () => {
    await withIntegrationFixture(`usage-${backend}`, async (fixture) => {
      const { client } = fixture;
      const executorId = backend === 'in-process' ? 'local' : client.executorId;
      const read = async (target: string) => {
        const summary = parseUsageSummary(await client.get(`/api/v1/usage?${new URLSearchParams({ executorId: target, ...window() })}`));
        if (!summary) throw new Error('Invalid usage summary');
        return summary;
      };

      const summary = await read(executorId);
      expect(summary).toMatchObject({ executorId, ...window(), pricingAsOf: expect.any(String) });
      const claude = agent(summary, 'claude');
      expect(claude).toMatchObject({ status: 'ok', scannedFiles: 1, distinctSessions: 1 });
      expect(claude.buckets).toHaveLength(1);
      expect(claude.buckets[0]).toMatchObject({
        day: day(-1),
        model: EXECUTOR_USAGE.claudeModel,
        records: 1,
        totals: { uncachedInputTokens: 1_000, cachedInputTokens: 10_000, cacheWriteTokens: 0, outputTokens: 2_000, reasoningTokens: 0 },
      });
      expect(claude.buckets[0]!.costUsd).toBeCloseTo((1_000 * 2 + 10_000 * 0.1 + 2_000 * 10) / 1_000_000, 6);
      const codex = agent(summary, 'codex');
      expect(codex.buckets).toEqual([expect.objectContaining({
        model: EXECUTOR_USAGE.codexModel,
        totals: { uncachedInputTokens: 1_000, cachedInputTokens: 4_000, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 40 },
      })]);
      expect(codex.buckets[0]!.costUsd).toBeCloseTo((1_000 * 1 + 4_000 * 0.05 + 100 * 5) / 1_000_000, 6);
      for (const other of summary.agents.filter((entry) => entry.agentId !== 'claude' && entry.agentId !== 'codex')) {
        expect(other.buckets).toEqual([]);
      }

      if (backend !== 'in-process') {
        // Local reads the controller's own home, never the worker's.
        const local = await read('local');
        expect(agent(local, 'claude').buckets.map((bucket) => bucket.model)).toEqual([CONTROLLER_USAGE.claudeModel]);
        expect(agent(local, 'codex').buckets.map((bucket) => bucket.model)).toEqual([CONTROLLER_USAGE.codexModel]);
      }

      expect(await rejectionOf(client.get(`/api/v1/usage?${new URLSearchParams({ executorId, ...window(), sinceDay: day(-120) })}`)))
        .toMatchObject({ status: 400 });
    }, {
      executionBackend: backend,
      prepareWorkspace: (directories) => seedTranscripts(directories.home, EXECUTOR_USAGE),
      prepareControllerWorkspace: backend === 'in-process'
        ? undefined
        : (directories) => seedTranscripts(directories.home, CONTROLLER_USAGE),
    });
  }, 60_000);
}
