import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { AgentRunFinishedMessage, ChatMessagesMessage } from '../../../common/ws-events.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

test('a delayed Stop cannot cancel a successor on the same native session', async () => {
  const gate = abortGate();
  try {
    await withIntegrationFixture('provider-abort-occurrence', async (fixture) => {
      const chatId = fixture.newChatId();
      const agent = fixture.directAgents.openAi;
      const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic first input' });
      const second = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic successor input' });
      try {
        await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic first input',
        });
        await first.received;
        const original = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: agent.agentId });
        expect(await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() }))
          .toMatchObject({ outcome: 'interrupt-requested' });
        await withTimeout(gate.entered.promise, 5_000, () => 'Stop did not reach the provider abort barrier');

        expect(first.releaseText('synthetic first response')).toBe(true);
        await fixture.client.waitForEvent(
          (message): message is ChatMessagesMessage => message.type === 'chat-messages'
            && message.chatId === chatId
            && assistantContents(message.messages).includes('synthetic first response'),
          'the interrupted occurrence finished its native work',
        );
        const successor = await fixture.client.runDirectChat({ chatId, agent, content: 'synthetic successor input' });
        await second.received;

        gate.release.resolve();
        expect(await withTimeout(gate.result.promise, 5_000, () => 'The delayed provider abort did not settle')).toBe(false);
        expect(second.releaseText('synthetic successor response')).toBe(true);
        expect(await fixture.client.waitForTurnTerminal(chatId, successor.turnId)).toMatchObject({ type: 'agent-run-finished' });
        const history = await fixture.client.getMessages(chatId);
        expect(userContents(history.messages)).toEqual(['synthetic first input', 'synthetic successor input']);
        expect(assistantContents(history.messages)).toEqual(['synthetic first response', 'synthetic successor response']);
        const current = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: agent.agentId });
        expect(current.agentSessionId).toBe(original.agentSessionId);
        expect(current.nativeSession).toEqual(original.nativeSession);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
      } finally {
        gate.release.resolve();
        first.releaseText('synthetic cleanup response');
        second.releaseText('synthetic cleanup response');
      }
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      preloadModules: [fileURLToPath(new URL('../../support/provider-abort-preload.ts', import.meta.url))],
      serverEnvironment: { GARCON_TEST_PROVIDER_ABORT_GATE: gate.url },
    });
  } finally { await gate.close(); }
}, 30_000);

test('Stop retains a delayed provider handle after an active goal handoff', async () => {
  const gate = abortGate();
  try {
    await withIntegrationFixture('provider-goal-handle', async (fixture) => {
      try {
        const chatId = fixture.newChatId();
        const agent = (await fixture.client.listAgentCatalog()).agents.find((entry) => entry.id === 'codex');
        if (!agent) throw new Error('Goal fixture provider is missing');
        const started = await fixture.client.startChat({
          origin: 'interactive', chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          agentId: agent.id, model: agent.defaultModel, agentSettings: agent.defaultSettings,
          projectPath: fixture.dirs.project, permissionMode: 'default', thinkingMode: 'none', command: 'synthetic initial goal',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const initial = await fixture.client.getMessages(chatId);
        const running = await fixture.client.runChat({
          chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          transcriptViewId: initial.transcriptViewId, command: 'synthetic resumed goal',
        });
        await withTimeout(gate.entered.promise, 5_000, () => 'Resume did not reach the handle barrier');
        const goal = await fixture.client.submitGoalControl({
          chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          transcriptViewId: initial.transcriptViewId, content: 'synthetic goal update',
        });
        expect(goal.delivery).toBe('active');
        expect(goal.turnId).not.toBe(running.turnId);
        expect(await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() }))
          .toMatchObject({ outcome: 'interrupt-requested' });
        await fixture.client.waitForTurnTerminal(chatId, goal.turnId!);
        gate.release.resolve();
        expect(await withTimeout(gate.result.promise, 5_000, () => 'The handed-off launch lost its abort handle')).toBe(true);
        const history = await fixture.client.getMessages(chatId);
        expect(userContents(history.messages)).toEqual(['synthetic initial goal', 'synthetic resumed goal', 'synthetic goal update']);
        await fixture.restartGarcon();
        expect(userContents((await fixture.client.getMessages(chatId)).messages))
          .toEqual(['synthetic initial goal', 'synthetic resumed goal', 'synthetic goal update']);
      } finally { gate.release.resolve(); }
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      preloadModules: [fileURLToPath(new URL('../../support/provider-goal-handle-preload.ts', import.meta.url))],
      serverEnvironment: { GARCON_TEST_PROVIDER_ABORT_GATE: gate.url },
    });
  } finally { await gate.close(); }
}, 30_000);

for (const commitMode of ['terminal', 'terminal-throw', 'transfer-throw']) {
  test(`goal commit preserves successor publication and cancellation for ${commitMode}`, async () => {
    const gate = abortGate();
    try {
      await withIntegrationFixture(`provider-goal-${commitMode}`, async (fixture) => {
        try {
          const chatId = fixture.newChatId();
          const agent = (await fixture.client.listAgentCatalog()).agents.find((entry) => entry.id === 'codex');
          if (!agent) throw new Error('Goal fixture provider is missing');
          const started = await fixture.client.startChat({
            origin: 'interactive', chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
            agentId: agent.id, model: agent.defaultModel, agentSettings: agent.defaultSettings,
            projectPath: fixture.dirs.project, permissionMode: 'default', thinkingMode: 'none', command: 'synthetic initial goal',
          });
          await fixture.client.waitForTurnTerminal(chatId, started.turnId);
          const initial = await fixture.client.getMessages(chatId);
          const running = await fixture.client.runChat({
            chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
            transcriptViewId: initial.transcriptViewId, command: 'synthetic resumed goal',
          });
          await withTimeout(gate.entered.promise, 5_000, () => 'Resume did not reach the handle barrier');
          const cursor = fixture.client.markEvents();
          const request = {
            chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
            transcriptViewId: initial.transcriptViewId, content: 'synthetic goal update',
          };
          if (commitMode === 'terminal') {
            const goal = await fixture.client.submitGoalControl(request);
            expect(goal.delivery).toBe('active');
            expect(goal.turnId).not.toBe(running.turnId);
          } else {
            await expect(fixture.client.submitGoalControl(request)).rejects.toMatchObject({
              status: 500, body: { errorCode: 'GOAL_CONTROL_OUTCOME_UNKNOWN', retryable: false },
            });
          }
          if (commitMode === 'transfer-throw') {
            const replay = await fixture.client.submitGoalControl(request);
            expect(replay).toMatchObject({ status: 'duplicate', delivery: 'active' });
            expect(await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() }))
              .toMatchObject({ outcome: 'interrupt-requested' });
            await fixture.client.waitForTurnTerminal(chatId, replay.turnId!);
            gate.release.resolve();
            expect(await withTimeout(gate.result.promise, 5_000, () => 'The uncertain goal lost its exact abort handle')).toBe(true);
          } else {
            const terminal = await fixture.client.waitForEvent(
              (event): event is AgentRunFinishedMessage => event.type === 'agent-run-finished' && event.chatId === chatId
                && event.clientRequestId === request.clientRequestId,
              'the synchronous successor terminal', { afterIndex: cursor },
            );
            await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
            const events = fixture.client.eventsSince(cursor);
            const outputIndex = events.findIndex((event) => event.type === 'chat-messages'
              && event.chatId === chatId && assistantContents(event.messages).includes('synthetic goal commit output'));
            expect(outputIndex).toBeGreaterThanOrEqual(0);
            expect(events.indexOf(terminal)).toBeGreaterThan(outputIndex);
            expect(events.filter((event) => event.type === 'agent-run-finished' && event.chatId === chatId
              && event.clientRequestId === request.clientRequestId)).toHaveLength(1);
            expect(await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() }))
              .toMatchObject({ outcome: 'already-idle' });
          }
          const history = await fixture.client.getMessages(chatId);
          expect(userContents(history.messages)).toEqual(['synthetic initial goal', 'synthetic resumed goal', 'synthetic goal update']);
          expect(assistantContents(history.messages)).toEqual(commitMode === 'transfer-throw' ? [] : ['synthetic goal commit output']);
          gate.release.resolve();
          await fixture.restartGarcon();
          expect((await fixture.client.getMessages(chatId)).messages).toEqual(history.messages);
        } finally { gate.release.resolve(); }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-goal-handle-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_PROVIDER_ABORT_GATE: gate.url, GARCON_TEST_GOAL_COMMIT_MODE: commitMode },
      });
    } finally { await gate.close(); }
  }, 30_000);
}

function abortGate() {
  const entered = new Deferred<void>();
  const release = new Deferred<void>();
  const result = new Deferred<boolean>();
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0, idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      if (path === '/hold') {
        entered.resolve();
        await release.promise;
        return new Response(null, { status: 204 });
      }
      if (path === '/result') {
        const value: unknown = await request.json();
        if (typeof value !== 'boolean') return new Response(null, { status: 400 });
        result.resolve(value);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`, entered, release, result,
    async close() { release.resolve(); await server.stop(true); },
  };
}
