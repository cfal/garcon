import { expect, test } from 'bun:test';
import { rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SEARCH_CORPUS_TIER_ISOLATION,
  SEARCH_CORPUS_TIER_M,
  SEARCH_CORPUS_TIER_S,
  bulkAppendCorpusRows,
  createSearchCorpusChats,
  derivedIndexDiskBytes,
  readDerivedIndexSnapshot,
} from '../../support/search-corpus-fixture.js';
import {
  createSearchPrefixPerformanceFixture,
  type SearchPrefixPerformanceFixture,
} from '../../support/search-prefix-performance-fixture.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { cpuSecondsOf, rssBytesOf, sampleDuty, trackPeakRss } from '../../support/process-probes.js';
import { TranscriptSearchService } from '../../../server-agents/common/src/search/transcript-search-service.js';

const LISTEN_BUDGET_MS = 60_000;
const BUILD_BUDGET_MS = 180_000;
const FIRST_SEARCH_BUDGET_MS = 2_000;
const CONVERGED_P50_BUDGET_MS = 150;
const CONVERGED_P95_BUDGET_MS = 750;
const RESTART_READY_BUDGET_MS = 5_000;
const IDLE_DUTY_CEILING = 0.02;
const BUILD_DUTY_MEAN_CEILING = 0.6;
const BUILD_DUTY_WINDOW_CEILING = 0.75;
const SERVER_RSS_DELTA_CEILING_BYTES = 600 * 1_024 * 1_024;
const DERIVED_BYTES_PER_BODY_BYTE = 2.5;
const RESTART_LOG_PATTERN = /SEARCH_(?:READER|INDEXER)_RESTARTED/;
const PREFIX_HARD_BUDGET_MS = 2_000;
const SHORT_PREFIX_P95_BUDGET_MS = 1_000;
const NEAR_CAP_PREFIX_HARD_BUDGET_MS = 4_250;
const NEAR_CAP_PREFIX_P50_BUDGET_MS = 3_500;
const CLIENT_PREFIX_BUDGET_MS = 4_500;

type ServiceSearchRequest = Parameters<TranscriptSearchService['search']>[0];

function searchQuery(...markers: string[]): ServiceSearchRequest['query'] {
  return {
    version: 1,
    clauses: markers.map((marker) => ({
      kind: 'all-words',
      tokens: [{ text: marker, normalized: marker, match: 'exact' }],
    })),
  };
}

function prefixRequest(
  fixture: SearchPrefixPerformanceFixture,
  options: {
    readonly allowedChats?: ServiceSearchRequest['allowedChats'];
    readonly order?: ServiceSearchRequest['order'];
    readonly markers?: readonly string[];
  } = {},
): ServiceSearchRequest {
  return {
    query: searchQuery(...(options.markers ?? [fixture.markerTerm])),
    allowedChats: options.allowedChats ?? fixture.allowedChats,
    order: options.order ?? 'relevance',
    mode: 'prefix',
    offset: 0,
    limit: 500,
    snippetLimit: 1,
    executionSignal: new AbortController().signal,
  };
}

async function timedServiceSearch(
  service: TranscriptSearchService,
  request: ServiceSearchRequest,
): Promise<{
  readonly elapsedMs: number;
  readonly result: Awaited<ReturnType<TranscriptSearchService['search']>>;
}> {
  const started = performance.now();
  const result = await service.search(request);
  return { elapsedMs: performance.now() - started, result };
}

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function searchService(workspaceDirectory: string): TranscriptSearchService {
  const discard = () => undefined;
  return new TranscriptSearchService({
    workspaceDirectory,
    logger: { debug: discard, info: discard, warn: discard, error: discard },
  });
}

test('[TLV5-SEARCH.10-GATE-01] production-shape cold start remains available and idempotent', async () => {
  await withIntegrationFixture('transcript-search-v9-scale-gate', async (fixture) => {
    const corpus = await createSearchCorpusChats(fixture, SEARCH_CORPUS_TIER_M);
    await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
    let totals = { rows: 0, bodyBytes: 0 };
    const restartStarted = performance.now();
    await fixture.restartGarcon({
      beforeStart: async () => {
        totals = await bulkAppendCorpusRows(
          fixture.dirs.workspace,
          corpus,
          SEARCH_CORPUS_TIER_M,
        );
        await rm(join(fixture.dirs.workspace, 'transcript-search'), {
          recursive: true,
          force: true,
        });
      },
    });
    expect(performance.now() - restartStarted).toBeLessThan(LISTEN_BUDGET_MS);
    expect(totals.rows).toBeGreaterThan(100_000);

    const initial = await fixture.client.waitForSearchPhase(['rebuilding'], { timeoutMs: 10_000 });
    expect(initial.resync?.totalChats).toBeGreaterThanOrEqual(
      SEARCH_CORPUS_TIER_M.denseChats + SEARCH_CORPUS_TIER_M.sparseChats,
    );
    expect(initial.resync!.completedChats).toBeLessThan(initial.resync!.totalChats);

    const pid = fixture.garcon.pid;
    if (!pid) throw new Error('Garcon process has no pid');
    const baselineRss = await rssBytesOf(pid);
    const rssTracker = trackPeakRss(pid);
    const buildCpuStart = await cpuSecondsOf(pid);
    const buildStarted = performance.now();

    let during: Awaited<ReturnType<typeof fixture.client.timedSearchChats>> | null = null;
    const duringDeadline = Date.now() + 60_000;
    while (Date.now() < duringDeadline) {
      const status = await fixture.client.waitForSearchPhase(
        ['rebuilding', 'ready', 'degraded'],
        { timeoutMs: 5_000 },
      );
      if (status.phase !== 'rebuilding') break;
      if (status.chats.indexed >= 1) {
        during = await fixture.client.timedSearchChats({ query: corpus.markerTerm, limit: 50 });
        break;
      }
      await Bun.sleep(200);
    }
    expect(during).not.toBeNull();
    expect(during!.status).toBe(200);
    expect(during!.elapsedMs).toBeLessThan(FIRST_SEARCH_BUDGET_MS);
    expect(during!.body.results.length).toBeGreaterThanOrEqual(1);
    expect(during!.body.index.pendingChatCount).toBeGreaterThan(0);

    for (let probe = 0; probe < 5; probe += 1) {
      const runtime = await fixture.client.timedGet('/api/v1/chats/search/status');
      expect(runtime.status).toBe(200);
      expect(runtime.elapsedMs).toBeLessThan(250);
      await Bun.sleep(1_000);
    }

    const dutyRatios: number[] = [];
    for (let window = 0; window < 3; window += 1) {
      const duty = await sampleDuty(pid, 10_000);
      const ratio = duty.cpuMs / duty.wallMs;
      expect(ratio).toBeLessThan(BUILD_DUTY_WINDOW_CEILING);
      dutyRatios.push(ratio);
    }
    expect(dutyRatios.reduce((sum, ratio) => sum + ratio, 0) / dutyRatios.length)
      .toBeLessThan(BUILD_DUTY_MEAN_CEILING);

    const ready = await fixture.client.waitForSearchPhase(['ready'], {
      timeoutMs: BUILD_BUDGET_MS,
    });
    const buildWallMs = performance.now() - buildStarted;
    expect(buildWallMs).toBeLessThan(BUILD_BUDGET_MS);
    expect(ready.chats.failed).toBe(0);
    expect(ready.queuedJobs).toBe(0);
    expect(ready.resync).toBeNull();
    expect(ready.backlogRows).toBe(0);
    const buildCpuSeconds = await cpuSecondsOf(pid) - buildCpuStart;
    expect(buildCpuSeconds).toBeLessThan((buildWallMs / 1_000) * BUILD_DUTY_MEAN_CEILING);

    const durations: number[] = [];
    for (let query = 0; query < 20; query += 1) {
      const timed = await fixture.client.timedSearchChats({ query: corpus.markerTerm, limit: 50 });
      expect(timed.status).toBe(200);
      expect(timed.body.index.pendingChatCount).toBe(0);
      expect(timed.body.results.length).toBeGreaterThanOrEqual(10);
      expect(timed.body.index.resultsTruncated).toBe(true);
      durations.push(timed.elapsedMs);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.floor(durations.length * 0.5)]).toBeLessThan(CONVERGED_P50_BUDGET_MS);
    expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(CONVERGED_P95_BUDGET_MS);
    const servedBeforePages = (await fixture.client.waitForSearchPhase(
      ['ready'],
      { timeoutMs: 5_000 },
    )).queryStats.served;
    const pageDurations: number[] = [];
    for (const offset of [0, 50, 100, 150, 200]) {
      const page = await fixture.client.timedSearchChats({
        query: corpus.deepMarkerTerm,
        sort: 'relevance',
        mode: 'page',
        offset,
        limit: 50,
        snippetLimit: 1,
      });
      expect(page.status).toBe(200);
      expect(page.elapsedMs).toBeLessThan(FIRST_SEARCH_BUDGET_MS);
      expect(page.body.page.offset).toBe(offset);
      expect(page.body.page.hasMore).toBe(page.body.page.nextOffset !== null);
      expect(page.body.results).toHaveLength(50);
      expect(page.body.results.every((result) => (
        result.snippets.length === 1
        && result.snippets[0]!.text.includes(corpus.deepMarkerTerm)
      ))).toBe(true);
      expect(page.body.index.resultsTruncated).toBe(false);
      pageDurations.push(page.elapsedMs);
    }
    pageDurations.sort((left, right) => left - right);
    expect(pageDurations[Math.floor(pageDurations.length * 0.95)])
      .toBeLessThan(CONVERGED_P95_BUDGET_MS);
    const servedAfterPages = (await fixture.client.waitForSearchPhase(
      ['ready'],
      { timeoutMs: 5_000 },
    )).queryStats.served;
    expect(servedAfterPages - servedBeforePages).toBe(5);
    for (const sort of ['activity', 'created'] as const) {
      const orderedPrefix = await fixture.client.timedSearchChats({
        query: corpus.deepMarkerTerm,
        sort,
        mode: 'prefix',
        offset: 0,
        limit: 250,
        snippetLimit: 1,
      });
      expect(orderedPrefix.status).toBe(200);
      expect(orderedPrefix.elapsedMs).toBeLessThan(PREFIX_HARD_BUDGET_MS);
      expect(orderedPrefix.body.results).toHaveLength(250);
      expect(orderedPrefix.body.mode).toBe('prefix');
      expect(orderedPrefix.body.snippetLimit).toBe(1);
    }
    const phraseDecoyChatId = corpus.phraseDecoyChatId;
    if (!phraseDecoyChatId) throw new Error('Tier M requires a phrase decoy chat');
    const multiClause = await fixture.client.timedSearchChats({
      query: `${corpus.markerTerm} ${corpus.secondaryMarkerTerm}`,
      limit: 50,
    });
    expect(multiClause.status).toBe(200);
    expect(multiClause.body.results.length).toBeGreaterThanOrEqual(10);
    expect(multiClause.body.results.some(
      (result) => result.chatId === phraseDecoyChatId,
    )).toBe(true);
    expect(multiClause.body.results.every((result) => (
      result.snippets.some((snippet) => (
        snippet.text.includes(corpus.markerTerm)
        && snippet.text.includes(corpus.secondaryMarkerTerm)
      ))
    ))).toBe(true);
    const multiClausePrefix = await fixture.client.timedSearchChats({
      query: `${corpus.markerTerm} ${corpus.secondaryMarkerTerm}`,
      mode: 'prefix',
      offset: 0,
      limit: 500,
      snippetLimit: 1,
    });
    expect(multiClausePrefix.status).toBe(200);
    expect(multiClausePrefix.elapsedMs).toBeLessThan(PREFIX_HARD_BUDGET_MS);
    expect(multiClausePrefix.body.results.length).toBeGreaterThanOrEqual(10);
    expect(multiClausePrefix.body.results.every((result) => result.snippets.length === 1))
      .toBe(true);
    const phrase = `${corpus.markerTerm} ${corpus.secondaryMarkerTerm}`;
    const quotedPhrase = await fixture.client.timedSearchChats({
      query: `"${phrase}"`,
      limit: 50,
    });
    expect(quotedPhrase.status).toBe(200);
    expect(quotedPhrase.body.results.length).toBeGreaterThanOrEqual(10);
    expect(quotedPhrase.body.results.some(
      (result) => result.chatId === phraseDecoyChatId,
    )).toBe(false);
    expect(quotedPhrase.body.results.every((result) => (
      result.snippets.some((snippet) => snippet.text.includes(phrase))
    ))).toBe(true);

    for (let round = 0; round < 10; round += 1) {
      const [left, right] = await Promise.all([
        fixture.client.timedSearchChats({ query: corpus.markerTerm, limit: 20 }),
        fixture.client.timedSearchChats({ query: corpus.markerTerm, limit: 20 }),
      ]);
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);
    }

    const rssPeak = await rssTracker.stop();
    expect(rssPeak - baselineRss).toBeLessThan(SERVER_RSS_DELTA_CEILING_BYTES);
    const snapshot = readDerivedIndexSnapshot(fixture.dirs.workspace);
    expect(snapshot.userVersion).toBe(9);
    expect(derivedIndexDiskBytes(fixture.dirs.workspace)).toBeLessThan(
      totals.bodyBytes * DERIVED_BYTES_PER_BODY_BYTE,
    );

    const idle = await sampleDuty(pid, 10_000);
    expect(idle.cpuMs / idle.wallMs).toBeLessThan(IDLE_DUTY_CEILING);
    expect(fixture.garcon.capturedOutput()).not.toMatch(RESTART_LOG_PATTERN);

    const secondRestartStarted = performance.now();
    await fixture.restartGarcon();
    expect(performance.now() - secondRestartStarted).toBeLessThan(LISTEN_BUDGET_MS);
    const listenedAt = performance.now();
    await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: RESTART_READY_BUDGET_MS });
    expect(performance.now() - listenedAt).toBeLessThan(RESTART_READY_BUDGET_MS);
    const after = readDerivedIndexSnapshot(fixture.dirs.workspace);
    expect(after.stateStamps).toEqual(snapshot.stateStamps);
    expect(after.maxChunkId).toBe(snapshot.maxChunkId);
    expect(after.chunkCount).toBe(snapshot.chunkCount);
    const afterRestart = await fixture.client.timedSearchChats({
      query: corpus.markerTerm,
      limit: 20,
    });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.results.length).toBeGreaterThan(0);
    expect(fixture.garcon.capturedOutput()).not.toMatch(RESTART_LOG_PATTERN);
  });
}, 900_000);

test('[TLV5-SEARCH.10-GATE-04] compact prefix stays bounded across 525 short chats', async () => {
  const fixture = await createSearchPrefixPerformanceFixture({
    chatCount: 525,
    rowsPerChat: 1,
    bodyCharacters: 780,
    name: 'shortprefix',
  });
  const service = searchService(fixture.workspaceDirectory);
  try {
    await service.enable(new AbortController().signal);
    const page = await timedServiceSearch(service, {
      ...prefixRequest(fixture),
      mode: 'page',
      limit: 50,
    });
    expect(page.elapsedMs).toBeLessThan(PREFIX_HARD_BUDGET_MS);
    expect(page.result.results).toHaveLength(50);

    for (let warmup = 0; warmup < 2; warmup += 1) {
      await service.search(prefixRequest(fixture));
    }
    const prefixDurations: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const measured = await timedServiceSearch(service, prefixRequest(fixture));
      expect(measured.elapsedMs).toBeLessThan(PREFIX_HARD_BUDGET_MS);
      expect(measured.result).toMatchObject({
        mode: 'prefix',
        snippetLimit: 1,
        page: { offset: 0, limit: 500, total: 525, hasMore: true, nextOffset: 500 },
        index: { resultsTruncated: false },
      });
      expect(measured.result.results).toHaveLength(500);
      expect(new Set(measured.result.results.map((result) => result.chatId)).size).toBe(500);
      expect(measured.result.results.every((result) => result.snippets.length === 1)).toBe(true);
      prefixDurations.push(measured.elapsedMs);
    }
    expect(percentile(prefixDurations, 0.95)).toBeLessThan(SHORT_PREFIX_P95_BUDGET_MS);

    const authoritativeOrders = [
      [...fixture.allowedChats].reverse(),
      [...fixture.allowedChats.slice(175), ...fixture.allowedChats.slice(0, 175)],
    ];
    for (const allowedChats of authoritativeOrders) {
      const measured = await timedServiceSearch(service, prefixRequest(fixture, {
        allowedChats,
        order: 'allowlist',
      }));
      expect(measured.elapsedMs).toBeLessThan(PREFIX_HARD_BUDGET_MS);
      expect(measured.result.results.map((result) => result.chatId))
        .toEqual(allowedChats.slice(0, 500).map((entry) => entry.chatId));
    }

    const multiClause = await timedServiceSearch(service, prefixRequest(fixture, {
      markers: [fixture.markerTerm, fixture.secondaryMarkerTerm],
    }));
    expect(multiClause.elapsedMs).toBeLessThan(PREFIX_HARD_BUDGET_MS);
    expect(multiClause.result.results).toHaveLength(500);
    expect(multiClause.result.results.every((result) => (
      result.snippets.length === 1
      && result.snippets[0]!.text.includes(fixture.markerTerm)
      && result.snippets[0]!.text.includes(fixture.secondaryMarkerTerm)
    ))).toBe(true);

    const stats = service.queryStats();
    expect(stats.served).toBe(11);
    expect(stats.totalP95Ms).toBeGreaterThanOrEqual(stats.p95Ms);
    expect(stats.totalP95Ms).toBeGreaterThanOrEqual(stats.admissionP95Ms);
  } finally {
    await service.close();
    await fixture.dispose();
  }
}, 120_000);

test('[TLV5-SEARCH.10-GATE-05] compact prefix retains near-cap client headroom', async () => {
  const fixture = await createSearchPrefixPerformanceFixture({
    chatCount: 600,
    rowsPerChat: 3,
    bodyCharacters: 63_983,
    name: 'nearcap',
  });
  const service = searchService(fixture.workspaceDirectory);
  try {
    await service.enable(new AbortController().signal);
    await service.search(prefixRequest(fixture));

    const durations: number[] = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const measured = await timedServiceSearch(service, prefixRequest(fixture));
      expect(measured.elapsedMs).toBeLessThan(NEAR_CAP_PREFIX_HARD_BUDGET_MS);
      expect(measured.result.results).toHaveLength(500);
      expect(measured.result.results.every((result) => result.snippets.length === 1)).toBe(true);
      durations.push(measured.elapsedMs);
    }
    expect(percentile(durations, 0.5)).toBeLessThan(NEAR_CAP_PREFIX_P50_BUDGET_MS);

    let deadlineTriggered = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const browserStarted = performance.now();
    const browserVisible = service.search(prefixRequest(fixture)).then(async (result) => {
      await Bun.sleep(200);
      return result;
    });
    const deadlineFailure = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        deadlineTriggered = true;
        reject(new Error('CLIENT_PREFIX_TIMEOUT'));
      }, 5_000);
    });
    const result = await Promise.race([browserVisible, deadlineFailure]);
    if (deadline) clearTimeout(deadline);
    expect(deadlineTriggered).toBe(false);
    expect(performance.now() - browserStarted).toBeLessThan(CLIENT_PREFIX_BUDGET_MS);
    expect(result.results).toHaveLength(500);
    const stats = service.queryStats();
    expect(stats.served).toBe(5);
    expect(stats.p50Ms).toBeLessThan(NEAR_CAP_PREFIX_P50_BUDGET_MS);
    expect(stats.totalP50Ms).toBeLessThan(NEAR_CAP_PREFIX_P50_BUDGET_MS);
  } finally {
    await service.close();
    await fixture.dispose();
  }
}, 180_000);

test('[TLV5-SEARCH.10-GATE-02] one corrupt ledger degrades only its chat', async () => {
  await withIntegrationFixture('transcript-search-v9-poisoned-ledger', async (fixture) => {
    const corpus = await createSearchCorpusChats(fixture, SEARCH_CORPUS_TIER_S);
    await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
    await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 30_000 });
    const poisoned = corpus.denseChatIds[0]!;
    const path = join(fixture.dirs.workspace, 'transcript-ledgers', poisoned, 'ledger.sqlite');
    await fixture.restartGarcon({
      beforeStart: async () => {
        const metadata = await stat(path);
        await truncate(path, Math.floor(metadata.size / 2));
      },
    });

    const degraded = await fixture.client.waitForSearchPhase(['degraded'], { timeoutMs: 30_000 });
    expect(degraded.chats.failed).toBeGreaterThanOrEqual(1);
    const result = await fixture.client.searchChats({ query: corpus.markerTerm, limit: 20 });
    expect(result.results.some((entry) => entry.chatId === poisoned)).toBe(false);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.index.failedChatCount).toBeGreaterThanOrEqual(1);
    expect(fixture.garcon.capturedOutput()).toContain('Transcript search indexing job failed');
    expect(fixture.garcon.capturedOutput()).not.toMatch(RESTART_LOG_PATTERN);
  });
}, 120_000);

test('[TLV5-SEARCH.10-GATE-03] oversized-chat build and deletion preserve liveness', async () => {
  await withIntegrationFixture('transcript-search-v9-large-chat-isolation', async (fixture) => {
    const corpus = await createSearchCorpusChats(fixture, SEARCH_CORPUS_TIER_ISOLATION);
    await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
    await fixture.restartGarcon({
      beforeStart: async () => {
        await bulkAppendCorpusRows(
          fixture.dirs.workspace,
          corpus,
          SEARCH_CORPUS_TIER_ISOLATION,
        );
        await rm(join(fixture.dirs.workspace, 'transcript-search'), {
          recursive: true,
          force: true,
        });
      },
    });

    const smallIds = [...corpus.denseChatIds, ...corpus.sparseChatIds];
    let duringBuild = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await fixture.client.waitForSearchPhase(
        ['rebuilding', 'ready', 'degraded'],
        { timeoutMs: 5_000 },
      );
      if (status.chats.indexed > 0 && status.chats.pending > 0) {
        duringBuild = await fixture.client.timedSearchChats({
          query: corpus.markerTerm,
          chatIds: smallIds,
          limit: 20,
        });
        break;
      }
      if (status.phase !== 'rebuilding') break;
      await Bun.sleep(100);
    }
    expect(duringBuild?.status).toBe(200);
    expect(duringBuild!.body.results.length).toBeGreaterThan(0);

    await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 120_000 });
    const oversizedChatId = corpus.oversizedChatId!;
    const deletion = fixture.client.deleteChat(oversizedChatId);
    const [runtime, search] = await Promise.all([
      fixture.client.timedGet('/api/v1/chats/search/status'),
      fixture.client.timedSearchChats({
        query: corpus.markerTerm,
        chatIds: smallIds,
        limit: 20,
      }),
    ]);
    expect(runtime.status).toBe(200);
    expect(runtime.elapsedMs).toBeLessThan(250);
    expect(search.status).toBe(200);
    await deletion;
    await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 120_000 });
    const settled = await fixture.client.searchChats({ query: corpus.markerTerm, limit: 20 });
    expect(settled.results.some((entry) => entry.chatId === oversizedChatId)).toBe(false);
    expect(fixture.garcon.capturedOutput()).not.toMatch(/WORKER_TIMEOUT|SEARCH_(?:READER|INDEXER)_RESTARTED/);
  });
}, 300_000);
