import { expect, test } from 'bun:test';
import { appendFile, readFile } from 'node:fs/promises';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import type { ChatHandoffArtifactResponse } from '../../../common/chat-handoff-artifact-contracts.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { appendDisplayRun, createDisplayChat } from '../../support/transcript-display-fixture.js';
import { displayRequest } from '../../support/transcript-display.js';
import { rejectionOf } from '../../support/promise-assertions.js';

// 30,000 native rows. Before whole-history work moved into bounded steps and a
// Worker, reloading a history this long held the server's event loop for over
// a second, which dropped browser heartbeats and executor links. The limit
// leaves room for shared CI runners, where remote-controller round trips can
// briefly exceed 200 ms without any step holding the loop. The bound remains
// well below the over-one-second stalls this test is intended to catch.
const TURNS = 15_000;
const BODY = 'Synthetic long-chat content with generic identifiers and no real data. '.repeat(3);
const PING_INTERVAL_MS = 25;
const MAX_PING_ROUND_TRIP_MS = 500;

test('a long chat reloads, forks, and renders a handoff artifact while the server stays responsive', async () => {
  await withIntegrationFixture('long-chat-responsiveness', async (fixture) => {
    const chatId = fixture.newChatId();
    const started = await fixture.client.startDirectChat({
      chatId,
      content: 'long-chat-seed',
      projectPath: fixture.dirs.project,
      agent: fixture.directAgents.openAi,
    });
    await fixture.client.waitForTurnTerminal(chatId, started.turnId);
    await appendSyntheticHistory(await directSessionPath(fixture, chatId), TURNS);

    const probe = startPingProbe(fixture);
    const reloaded = await fixture.client.reloadChat(chatId);
    const fork = await fixture.client.forkChat({ sourceChatId: chatId, chatId: fixture.newChatId() });
    const artifact = await fixture.client.get<ChatHandoffArtifactResponse>(
      `/api/v1/chats/handoff-artifact?${new URLSearchParams({ chatId, contextWindowTokens: '131072' })}`,
    );
    const responsiveness = await probe.stop();

    expect(reloaded.lastOrdinal).toBeGreaterThan(TURNS * 2);
    expect((await fixture.client.getMessages(fork.chat.id)).lastOrdinal).toBeGreaterThan(TURNS * 2);
    expect(artifact.sourceEntryCount).toBeGreaterThan(TURNS * 2);
    expect(artifact.budgetOmittedEntryCount).toBeGreaterThan(0);
    expect(responsiveness.samples).toBeGreaterThan(10);
    expect(responsiveness.maxRoundTripMs).toBeLessThan(MAX_PING_ROUND_TRIP_MS);
  });
}, 180_000);

test('display preparation and a failed regex leave growing chats and ready reads responsive', async () => {
  await withIntegrationFixture('display-preparation-responsiveness', async fixture => {
    const healthy = [await createDisplayChat(fixture), await createDisplayChat(fixture)];
    const cold = await createDisplayChat(fixture), pathological = await createDisplayChat(fixture);
    await fixture.restartGarcon({ beforeStart: async () => {
      await appendDisplayRun(fixture.dirs.workspace, cold, 40_000);
      await appendDisplayRun(fixture.dirs.workspace, pathological, 16, `${'a'.repeat(8192)}!`);
    } });
    for (const chatId of healthy) {
      const open = await fixture.client.openDisplay({ chatId, reason: 'activate', outstandingClientMessageIds: [] });
      await fixture.client.waitForDisplayWindow(displayRequest(open));
    }
    const probe = startPingProbe(fixture);
    let responsiveness;
    try {
      await fixture.client.updateSettings({ ui: { hiddenBashCommandPatterns: [{ pattern: '^(a+)+$', mode: 'regex' }] } });
      const bad = await fixture.client.openDisplay({ chatId: pathological, reason: 'activate', outstandingClientMessageIds: [] });
      const building = await fixture.client.openDisplay({ chatId: cold, reason: 'activate', outstandingClientMessageIds: [] });
      const request = displayRequest(building);
      // Publication and reader work run while the builder owns the pathological match.
      for (let index = 0; index < 8; index++) {
        const chatId = healthy[index % healthy.length];
        const turn = await fixture.client.runDirectChat({ chatId, content: `Synthetic concurrent append ${index}`, agent: fixture.directAgents.openAi });
        await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
        const open = await fixture.client.openDisplay({ chatId, reason: 'reconnect', outstandingClientMessageIds: [] });
        const current = await fixture.client.displayWindow(displayRequest(open, { requiredThrough: 1 }));
        expect(current.kind).toBe('available');
      }
      const deadline = Date.now() + 15_000;
      let failed = await fixture.client.displayWindow(displayRequest(bad));
      while (failed.kind !== 'failed' && Date.now() < deadline) {
        await Bun.sleep(100);
        failed = await fixture.client.displayWindow(displayRequest(bad));
      }
      expect(failed).toMatchObject({ kind: 'failed', errorCode: 'DISPLAY_FILTER_TIMEOUT' });
      expect(await rejectionOf(fixture.client.resolveDisplay({ ...displayRequest(bad), anchor: { kind: 'around', ordinal: 1 } })))
        .toMatchObject({ status: 503, body: { errorCode: 'DISPLAY_FILTER_TIMEOUT' } });
      expect((await fixture.client.waitForDisplayWindow(request, 90_000)).items.find(item => item.kind === 'tool-group')).toMatchObject({ count: 40_000 });
      await fixture.client.updateSettings({ ui: { hiddenBashCommandPatterns: [] } });
      const repaired = await fixture.client.openDisplay({ chatId: pathological, reason: 'reconnect', outstandingClientMessageIds: [] });
      expect((await fixture.client.waitForDisplayWindow(displayRequest(repaired))).items.some(item => item.kind === 'tool-group')).toBe(true);
    } finally { responsiveness = await probe.stop(); }
    console.log(JSON.stringify({ displayPreparationHeartbeat: responsiveness }));
    expect(responsiveness.samples).toBeGreaterThan(10);
    expect(responsiveness.maxRoundTripMs).toBeLessThan(MAX_PING_ROUND_TRIP_MS);
  });
}, 180_000);

function startPingProbe(fixture: IntegrationFixture) {
  let stopped = false;
  let maxRoundTripMs = 0;
  let samples = 0;
  const probing = (async () => {
    while (!stopped) {
      const sentAt = performance.now();
      await fixture.client.ping();
      maxRoundTripMs = Math.max(maxRoundTripMs, performance.now() - sentAt);
      samples += 1;
      await Bun.sleep(PING_INTERVAL_MS);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await probing;
      return { maxRoundTripMs, samples };
    },
  };
}

async function appendSyntheticHistory(path: string, turns: number): Promise<void> {
  const existing = await readFile(path);
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const runId = `synthetic-long-chat-run-${turn}`;
    const at = new Date(Date.UTC(2026, 0, 1) + turn * 1_000).toISOString();
    lines.push(JSON.stringify({ type: 'user', at, runId, content: `Request ${turn}. ${BODY}`, attachments: [] }));
    lines.push(JSON.stringify({ type: 'assistant', at, runId, content: `Reply ${turn}. ${BODY}`, checkpoint: null }));
  }
  const separator = existing.at(-1) === 0x0a ? '' : '\n';
  await appendFile(path, `${separator}${lines.join('\n')}\n`);
}

async function directSessionPath(fixture: IntegrationFixture, chatId: string): Promise<string> {
  const details = await fixture.client.get<ChatDetailsResponse>(
    `/api/v1/chats/details?${new URLSearchParams({ chatId })}`,
  );
  if (details.transcriptSource?.kind !== 'filesystem-path') {
    throw new Error(`Chat ${chatId} has no Direct filesystem source.`);
  }
  return details.transcriptSource.value;
}
