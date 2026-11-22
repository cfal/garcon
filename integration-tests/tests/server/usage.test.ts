import { expect, test } from 'bun:test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseUsageSummary, type UsageSummary } from '../../../common/usage.js';
import { executionBackend } from '../../support/execution-backend.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const DAY_MS = 86_400_000;
// Fixed once per run, so seeding, requests, and assertions agree across UTC midnight.
const TODAY_MS = Date.now();
const day = (offset: number) => new Date(TODAY_MS + offset * DAY_MS).toISOString().slice(0, 10);
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

async function readUsage(client: GarconTestClient, executorId = client.executorId): Promise<UsageSummary> {
  const query = new URLSearchParams({ executorId, ...window() });
  const summary = parseUsageSummary(await client.get(`/api/v1/usage?${query}`));
  if (!summary) throw new Error('Invalid usage summary');
  return summary;
}

const EXECUTOR_USAGE = { claudeModel: 'claude-sonnet-5-5', codexModel: 'gpt-6.1-terra' };
const CONTROLLER_USAGE = { claudeModel: 'claude-haiku-5-5', codexModel: 'gpt-6-luna' };

const backend = executionBackend();

test(`usage counts Codex fork responses once across incremental scans (${backend})`, async () => {
  await withIntegrationFixture('usage-codex-fork', async (fixture) => {
    const usageDay = day(-1);
    const dir = join(fixture.executionDirs.home, '.codex', 'sessions', ...usageDay.split('-'));
    await mkdir(dir, { recursive: true });
    const parentId = '00000000-0000-7000-8000-000000000001';
    const forkId = '00000000-0000-7000-8000-000000000002';
    const copyId = '00000000-0000-4000-8000-000000000003';
    const start = Date.parse(`${usageDay}T12:00:00Z`);
    const row = (ms: number, type: string, payload: object) =>
      JSON.stringify({ timestamp: new Date(start + ms).toISOString(), type, payload }) + '\n';
    const model = 'gpt-6-sol';
    const usage = (output: number) => ({ input_tokens: 0, output_tokens: output, total_tokens: output });
    const response = (ms: number, threadId: string, turnId: string, responseId: string, output: number) =>
      row(ms, 'token_usage_record', { thread_id: threadId, turn_id: turnId, response_id: responseId, usage: usage(output) });
    const turn = (ms: number, turnId: string, tier: string) =>
      row(ms, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model, service_tier: tier } })
      + row(ms, 'event_msg', { type: 'task_started', turn_id: turnId })
      + row(ms, 'turn_context', { turn_id: turnId, model });
    const sourceTurn = 'source-turn';
    const sharedHistory = turn(1, 'inherited-turn', 'default')
      + response(5, parentId, 'inherited-turn', 'inherited', 1000)
      + turn(10, sourceTurn, 'priority');
    // A point fork retargets metadata, not the response IDs or their owning thread.
    const seedRollout = async (id: string) => {
      const path = join(dir, `rollout-synthetic-${id}.jsonl`);
      await writeFile(path, row(0, 'session_meta', { id, forked_from_id: parentId }) + sharedHistory);
      return path;
    };
    const forkPath = await seedRollout(forkId);
    const copyPath = await seedRollout(copyId);
    const readCodexUsage = async () => agent(await readUsage(fixture.client), 'codex');
    expect(await readCodexUsage()).toMatchObject({ status: 'ok', scannedFiles: 2, buckets: [] });

    const firstOutput = 100;
    const quickResponse = response(500, forkId, sourceTurn, 'first', firstOutput);
    await appendFile(forkPath, quickResponse);
    await appendFile(copyPath, quickResponse);
    expect(await readCodexUsage()).toMatchObject({ status: 'ok', scannedFiles: 2, distinctSessions: 1, buckets: [{
      day: usageDay, model, records: 1, totals: { outputTokens: 100 }, costUsd: 100 * 20 / 1_000_000,
    }] });

    // The copy skipped the first response; its delayed counter must not bill it again.
    const snapshot = usage(firstOutput);
    const delayedCounter = row(2000, 'event_msg', {
      type: 'token_count', info: { last_token_usage: snapshot, total_token_usage: snapshot },
    });
    const sharedTail = delayedCounter + response(3000, forkId, sourceTurn, 'second', 25);
    const copyTurn = turn(4000, 'copy-turn', 'default') + response(4100, copyId, 'copy-turn', 'third', 10);
    await appendFile(forkPath, sharedTail);
    await appendFile(copyPath, sharedTail + copyTurn);
    expect(await readCodexUsage()).toMatchObject({ status: 'ok', scannedFiles: 2, distinctSessions: 2, buckets: [{
      day: usageDay, model, records: 3, totals: { outputTokens: 135 }, costUsd: (125 * 20 + 10 * 10) / 1_000_000,
    }] });
  });
}, 60_000);

test(`usage reads Claude and Codex transcripts on the selected executor (${backend})`, async () => {
  await withIntegrationFixture(`usage-${backend}`, async (fixture) => {
    const { client } = fixture;
    const executorId = client.executorId;
    const summary = await readUsage(client);
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

    if (executorId !== 'local') {
      // Local reads the controller's own home, never the worker's.
      const local = await readUsage(client, 'local');
      expect(agent(local, 'claude').buckets.map((bucket) => bucket.model)).toEqual([CONTROLLER_USAGE.claudeModel]);
      expect(agent(local, 'codex').buckets.map((bucket) => bucket.model)).toEqual([CONTROLLER_USAGE.codexModel]);
    }

    expect(await rejectionOf(client.get(`/api/v1/usage?${new URLSearchParams({ executorId, ...window(), sinceDay: day(-120) })}`)))
      .toMatchObject({ status: 400 });
    expect(await rejectionOf(client.get(`/api/v1/usage?${new URLSearchParams({ executorId, sinceDay: day(1), untilDay: day(3), timeZone: 'UTC' })}`)))
      .toMatchObject({ status: 400 });
  }, {
    prepareWorkspace: (directories) => seedTranscripts(directories.home, EXECUTOR_USAGE),
    prepareControllerWorkspace: backend === 'in-process'
      ? undefined
      : (directories) => seedTranscripts(directories.home, CONTROLLER_USAGE),
  });
}, 60_000);
