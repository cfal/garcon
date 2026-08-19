import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SEARCH_CORPUS_TIER_M,
  bulkAppendCorpusRows,
  createSearchCorpusChats,
  readDerivedIndexSnapshot,
} from '../../support/search-corpus-fixture.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rssBytesOf, trackPeakRss } from '../../support/process-probes.js';

const CHURN_MS = 15 * 60_000;
const APPEND_INTERVAL_MS = 2_000;
const SEARCH_INTERVAL_MS = 5_000;
const ROTATION_INTERVAL_MS = 60_000;
const RSS_DELTA_CEILING_BYTES = 600 * 1_024 * 1_024;
const RESTART_LOG_PATTERN = /WORKER_TIMEOUT|SEARCH_(?:READER|INDEXER)_RESTARTED/;

test('[TLV5-SEARCH.10-ENDURANCE-01] sustained append, query, and deletion churn remains bounded', async () => {
  await withIntegrationFixture('transcript-search-v9-endurance', async (fixture) => {
    const corpus = await createSearchCorpusChats(fixture, SEARCH_CORPUS_TIER_M);
    await fixture.client.updateSettings({ features: { transcriptSearch: { enabled: true } } });
    await fixture.restartGarcon({
      beforeStart: async () => {
        await bulkAppendCorpusRows(fixture.dirs.workspace, corpus, SEARCH_CORPUS_TIER_M);
        await rm(join(fixture.dirs.workspace, 'transcript-search'), {
          recursive: true,
          force: true,
        });
      },
    });
    await fixture.client.waitForSearchPhase(['ready'], { timeoutMs: 180_000 });

    const pid = fixture.garcon.pid;
    if (!pid) throw new Error('Garcon process has no pid');
    const baselineRss = await rssBytesOf(pid);
    const rssTracker = trackPeakRss(pid);
    const churnChatIds = [...corpus.sparseChatIds];
    const searchDurations: number[] = [];
    const started = Date.now();
    let nextAppend = started;
    let nextSearch = started;
    let nextRotation = started + ROTATION_INTERVAL_MS;
    let appendSequence = 0;
    let rotationSequence = 0;

    while (Date.now() - started < CHURN_MS) {
      const now = Date.now();
      if (now >= nextAppend) {
        const chatId = churnChatIds[appendSequence % churnChatIds.length]!;
        const turn = await fixture.client.runDirectChat({
          chatId,
          content: `synthetic endurance append ${appendSequence}`,
          agent: fixture.directAgents.openAi,
        });
        await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
        appendSequence += 1;
        nextAppend += APPEND_INTERVAL_MS;
      }
      if (now >= nextSearch) {
        const timed = await fixture.client.timedSearchChats({
          query: corpus.markerTerm,
          limit: 20,
        });
        expect(timed.status).toBe(200);
        searchDurations.push(timed.elapsedMs);
        nextSearch += SEARCH_INTERVAL_MS;
      }
      if (now >= nextRotation) {
        const slot = rotationSequence % churnChatIds.length;
        await fixture.client.deleteChat(churnChatIds[slot]!);
        const chatId = fixture.newChatId();
        const turn = await fixture.client.startDirectChat({
          chatId,
          content: `synthetic endurance replacement ${rotationSequence}`,
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.openAi,
        });
        await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
        churnChatIds[slot] = chatId;
        rotationSequence += 1;
        nextRotation += ROTATION_INTERVAL_MS;

        const recent = searchDurations.slice(-12).sort((left, right) => left - right);
        if (recent.length > 0) {
          expect(recent[Math.floor(recent.length * 0.95)]).toBeLessThan(1_000);
        }
      }
      const next = Math.min(nextAppend, nextSearch, nextRotation, started + CHURN_MS);
      await Bun.sleep(Math.max(0, Math.min(250, next - Date.now())));
    }

    const settled = await fixture.client.waitForSearchPhase(['ready', 'degraded'], {
      timeoutMs: 10_000,
    });
    expect(settled.backlogRows).toBe(0);
    expect(settled.chats.pending).toBe(0);
    const peakRss = await rssTracker.stop();
    expect(peakRss - baselineRss).toBeLessThan(RSS_DELTA_CEILING_BYTES);
    expect(fixture.garcon.capturedOutput()).not.toMatch(RESTART_LOG_PATTERN);

    const beforeRestart = readDerivedIndexSnapshot(fixture.dirs.workspace);
    await fixture.restartGarcon();
    await fixture.client.waitForSearchPhase(['ready', 'degraded'], { timeoutMs: 5_000 });
    const afterRestart = readDerivedIndexSnapshot(fixture.dirs.workspace);
    expect(afterRestart.stateStamps).toEqual(beforeRestart.stateStamps);
    expect(afterRestart.chunkCount).toBe(beforeRestart.chunkCount);
    expect(afterRestart.maxChunkId).toBe(beforeRestart.maxChunkId);
    expect(fixture.garcon.capturedOutput()).not.toMatch(RESTART_LOG_PATTERN);
  });
}, 2_400_000);
