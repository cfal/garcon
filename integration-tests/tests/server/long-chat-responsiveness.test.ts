import { expect, test } from 'bun:test';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseNativeObservationOrigin } from '../../../server/controller/chats/native-observation.js';
import { parseClaudeChildRef } from '../../../server-agents/claude/src/agents/claude/native-child-history.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import type { ChatHandoffArtifactResponse } from '../../../common/chat-handoff-artifact-contracts.js';
import type { AddChatRowRequest, AddChatRowResponse } from '../../../common/chat-row-contracts.js';
import { isCompleteTranscriptAnchorResponse, parseTranscriptAnchorResponse, type TranscriptAnchorRequest } from '../../../common/transcript-anchor-page.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

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

test('a long chat reloads, reads combined history, forks, and renders while the server stays responsive', async () => {
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
    const notice = await fixture.client.post<AddChatRowResponse>('/api/v1/chats/rows', {
      clientRequestId: 'synthetic-responsiveness-request',
      clientMessageId: 'synthetic-responsiveness-row',
      chatId,
      transcriptViewId: reloaded.transcriptViewId,
      presentation: { style: 'notice' },
      format: 'plain',
      disclosure: 'expanded',
      content: 'Synthetic non-anchor row.',
    } satisfies AddChatRowRequest);
    const request: TranscriptAnchorRequest = { chatId, direction: 'backward', anchorsRemaining: 200 };
    const combined = parseTranscriptAnchorResponse(request,
      await fixture.client.post<unknown>('/api/v1/chats/combined-messages', request));
    if (!isCompleteTranscriptAnchorResponse(combined)) throw new Error('Synthetic history unavailable');
    expect(combined).toMatchObject({
      pageStatus: 'complete', anchorsRemaining: 0,
      startOrdinal: notice.ordinal - 200, endOrdinal: notice.ordinal + 1,
    });
    expect(combined.messages.map(entry => entry.ordinal)).toEqual(
      Array.from({ length: 201 }, (_, index) => notice.ordinal - 200 + index),
    );
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

test('[TLV5-OBSERVE.06-RESPONSIVENESS-01] a long native-child history reload preserves controller and worker responsiveness', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  environment.model.scriptTurn([claudeToolUse('toolu_long_child', 'Agent', {
    subagent_type: 'general-purpose', description: 'Synthetic long child',
    prompt: 'Synthetic long child kickoff', run_in_background: false,
  })]);
  environment.model.scriptTurn([claudeText('Synthetic child answer')]);
  environment.model.scriptTurn([claudeText('Synthetic parent answer')]);
  try {
    await withIntegrationFixture('long-native-child-responsiveness', async fixture => {
      const parentId = fixture.newChatId();
      const started = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: parentId, projectPath: fixture.executionDirs.project,
        command: 'Synthetic long parent request', permissionMode: 'bypassPermissions',
      }));
      await fixture.client.waitForTurnTerminal(parentId, started.turnId, { timeoutMs: 60_000 });
      const child = (await fixture.client.listChats()).sessions.find(chat => chat.parentChatId === parentId);
      if (!child) throw new Error('Missing observed child');
      const origin = await waitForPersistedChat({ directories: fixture.dirs, chatId: child.id,
        select: entry => parseNativeObservationOrigin(entry.nativeObservation, 'claude'),
        timeoutMessage: 'Missing synthetic child provenance' });
      const locator = parseClaudeChildRef(origin.child);
      const source = join(dirname(locator.rootNativePath), locator.rootSessionId, 'subagents', `agent-${locator.agentId}.jsonl`);
      for (let start = 0; start < TURNS * 2; start += 500) {
        const lines: string[] = [];
        for (let index = start; index < start + 500; index++) {
          const role = index % 2 ? 'assistant' : 'user';
          lines.push(JSON.stringify({ type: role, uuid: `synthetic-row-${index}`,
            parentUuid: index ? `synthetic-row-${index - 1}` : null,
            sessionId: locator.rootSessionId, agentId: locator.agentId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: { role, content: [{ type: 'text', text: `Synthetic row ${index}. ${BODY}` }] } }));
        }
        await appendFile(source, `${lines.join('\n')}\n`);
      }
      const probe = startPingProbe(fixture);
      try {
        const reloaded = await fixture.client.reloadChat(child.id);
        expect(reloaded.lastOrdinal).toBe(TURNS * 2 + 1);
        expect((await fixture.client.getChatSnapshot(child.id)).chat.observation?.captureStatus).toBe('detached');
      } finally {
        const responsiveness = await probe.stop();
        expect(responsiveness.samples).toBeGreaterThan(10);
        expect(responsiveness.maxRoundTripMs).toBeLessThan(MAX_PING_ROUND_TRIP_MS);
      }
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment });
  } finally { environment.dispose(); }
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
