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
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { cpuSecondsOf, rssBytesOf, sampleDuty, trackPeakRss } from '../../support/process-probes.js';

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
      durations.push(timed.elapsedMs);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.floor(durations.length * 0.5)]).toBeLessThan(CONVERGED_P50_BUDGET_MS);
    expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(CONVERGED_P95_BUDGET_MS);
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
