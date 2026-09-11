import { describe, expect, test } from 'bun:test';
import { userContents } from '../../support/chat-assertions.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiProviderCatalogEntry } from '../../../common/api-providers.js';
import type { ExecutionSettingsPatchResponse } from '../../../common/chat-command-contracts.js';
import { parseAgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import { isRecord } from '../../../common/json.js';
import type { ChatListRefreshRequestedMessage, ChatMessagesMessage } from '../../../common/ws-events.js';
import type { ProviderSessionConfigurationRequest, ProviderSessionConfigurationResult } from '../../../server/execution-nodes/provider-configuration.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { fakeOpenAiRequestHeaders } from '../../support/openai-test-contract.js';

describe('provider configuration through HTTP', () => {
  for (const operation of ['start', 'resume', 'single-query'] as const) {
    test(`${operation} dispatches the URL and credential captured before asynchronous validation`, async () => {
      const gate = validationGate();
      try {
        await withIntegrationFixture(`configuration-snapshot-${operation}`, async (fixture) => {
          const chatId = fixture.newChatId();
          const agent = fixture.directAgents.openAi;
          const requests: { path: string; authorization: string | null }[] = [];
          const endpoint = Bun.serve({
            hostname: '0.0.0.0', port: 0, idleTimeout: 0,
            async fetch(request) {
              requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization') });
              return fetch(`${fixture.fakeProviders.openAi.baseUrl}/v1/chat/completions`, {
                method: 'POST', headers: fakeOpenAiRequestHeaders(), body: await request.text(), signal: request.signal,
              });
            },
          });
          try {
            const originalBaseUrl = `http://127.0.0.1:${endpoint.port}/original`;
            const changedBaseUrl = `http://127.0.0.1:${endpoint.port}/updated`;
            await fixture.client.put<ApiProviderCatalogEntry>(`/api/v1/api-providers?id=${agent.provider.providerId}`, {
              endpoint: { baseUrl: originalBaseUrl, apiKey: 'synthetic-original-key' },
            });
            if (operation === 'resume') {
              const started = await fixture.client.startDirectChat({
                chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic initial input',
              });
              await fixture.client.waitForTurnTerminal(chatId, started.turnId);
            }
            if (operation === 'single-query') {
              await fixture.client.updateSettings({ ui: { promptRefinement: {
                agentId: agent.agentId, model: agent.provider.model,
                apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
                modelProtocol: agent.provider.protocol, thinkingMode: 'none',
              } } });
            }

            const validation = gate.holdNext();
            const output = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
            const input = { chatId, agent, content: 'synthetic validated input' };
            const pending = operation === 'single-query'
              ? fixture.client.refinePrompt({ draft: input.content, target: 'prompt' })
              : operation === 'start'
                ? fixture.client.startDirectChat({ ...input, projectPath: fixture.dirs.project })
                : fixture.client.runDirectChat(input);
            void pending.catch(() => undefined);
            try {
              expect(await withTimeout(validation.entered.promise, 5_000,
                () => 'Provider did not enter endpoint validation')).toMatchObject({
                baseUrl: originalBaseUrl, model: agent.provider.model, endpointId: agent.provider.endpointId,
              });
              expect(fixture.fakeProviders.openAi.requests()).toHaveLength(operation === 'resume' ? 1 : 0);
              const changed = await fixture.client.put<ApiProviderCatalogEntry>(
                `/api/v1/api-providers?id=${agent.provider.providerId}`,
                { endpoint: { baseUrl: changedBaseUrl, apiKey: 'synthetic-updated-key' } },
              );
              expect(changed.endpoints.find((endpoint) => endpoint.id === agent.provider.endpointId)?.baseUrl).toBe(changedBaseUrl);
              validation.release.resolve(true);
              expect((await output.received).body.model).toBe(agent.provider.model);
              expect(requests.every((request) => request.path === '/original/chat/completions'
                && request.authorization === 'Bearer synthetic-original-key')).toBe(true);
              expect(output.releaseText('synthetic validated result')).toBeTrue();
              const result = await pending;
              if ('refinedPrompt' in result) {
                expect(result).toEqual({ success: true, refinedPrompt: 'synthetic validated result' });
              } else {
                await fixture.client.waitForTurnTerminal(chatId, result.turnId);
                expect(parseAgentTurnReceipt(await fixture.client.get(
                  `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${result.turnId}`,
                ))).toMatchObject({ state: 'completed' });
                expect((await fixture.client.getMessages(chatId)).messages.some((row) =>
                  'content' in row.message && row.message.content === 'synthetic validated result')).toBeTrue();
              }
              expect(fixture.fakeProviders.openAi.requests()).toHaveLength(operation === 'resume' ? 2 : 1);
              const next = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
              const following = operation === 'single-query'
                ? fixture.client.refinePrompt({ draft: 'synthetic next input', target: 'prompt' })
                : fixture.client.runDirectChat({ chatId, agent, content: 'synthetic next input' });
              try {
                await next.received;
                expect(requests.at(-1)).toEqual({ path: '/updated/chat/completions', authorization: 'Bearer synthetic-updated-key' });
                next.releaseText('synthetic next result');
                const result = await following;
                if ('refinedPrompt' in result) expect(result.refinedPrompt).toBe('synthetic next result');
                else await fixture.client.waitForTurnTerminal(chatId, result.turnId);
              } finally {
                next.allowAbort();
                next.releaseText('synthetic cleanup result');
                await following.catch(() => undefined);
              }
            } finally {
              validation.release.resolve(false);
              output.allowAbort();
              output.releaseText('synthetic cleanup result');
              await pending.catch(() => undefined);
            }
          } finally { await endpoint.stop(true); }
        }, {
          authentication: 'account', bindAddress: '0.0.0.0',
          preloadModules: [fileURLToPath(new URL('../../support/provider-configuration-preload.ts', import.meta.url))],
          serverEnvironment: { GARCON_TEST_CONFIGURATION_GATE: gate.url },
        });
      } finally { await gate.close(); }
    }, 30_000);
  }

  test('rejects provider preparation before committing an existing-chat input', async () => {
    const gate = validationGate();
    try {
      await withIntegrationFixture('execution-preparation-refusal', async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const started = await fixture.client.startDirectChat({ chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic initial input' });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const before = await fixture.client.getMessages(chatId);
        const validation = gate.holdNext();
        const pending = fixture.client.runDirectChat({ chatId, agent, content: 'synthetic rejected input' });
        void pending.catch(() => {});
        try {
          await withTimeout(validation.entered.promise, 5_000, () => 'Execution preparation did not validate');
          expect(await fixture.client.getMessages(chatId)).toEqual(before);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
          validation.release.resolve(false);
          await expect(pending).rejects.toMatchObject({ status: 500 });
          expect(await fixture.client.getMessages(chatId)).toEqual(before);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
        } finally { validation.release.resolve(false); await pending.catch(() => {}); }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-configuration-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_CONFIGURATION_GATE: gate.url },
      });
    } finally { await gate.close(); }
  }, 30_000);

  test('keeps a queued input editable during preparation and dispatches its revised head once', async () => {
    const gate = validationGate();
    try {
      await withIntegrationFixture('execution-preparation-queue-edit', async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic queue initial' });
        const revised = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic revised queue input' });
        let validation: ReturnType<typeof gate.holdNext> | undefined;
        try {
          await fixture.client.startDirectChat({ chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic queue initial' });
          await first.received;
          const queued = await fixture.client.enqueueNew(chatId, 'synthetic original queue input');
          validation = gate.holdNext();
          first.releaseText('synthetic initial response');
          await withTimeout(validation.entered.promise, 5_000, () => 'Queued execution preparation did not validate');
          const control = await fixture.client.getExecutionControl(chatId);
          expect(control.queue.entries.map((entry) => entry.content)).toEqual(['synthetic original queue input']);
          expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['synthetic queue initial']);
          await withTimeout(fixture.client.replaceQueued({
            chatId, entryId: queued.entryId, expectedRevision: control.queue.entries[0]!.revision,
            clientRequestId: crypto.randomUUID(), content: 'synthetic revised queue input',
          }), 5_000, () => 'Provider preparation held the queue mutation lock');
          validation.release.resolve(true);
          await revised.received;
          const afterIndex = fixture.client.events().length;
          revised.releaseText('synthetic revised response');
          await fixture.client.waitForProcessing(chatId, false, { afterIndex });
          expect(userContents((await fixture.client.getMessages(chatId)).messages))
            .toEqual(['synthetic queue initial', 'synthetic revised queue input']);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
          expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
        } finally {
          validation?.release.resolve(false);
          first.releaseText('synthetic cleanup');
          revised.releaseText('synthetic cleanup');
        }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-configuration-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_CONFIGURATION_GATE: gate.url },
      });
    } finally { await gate.close(); }
  }, 30_000);

  test('a rejected control preparation cannot block the following queued user input', async () => {
    const gate = validationGate();
    try {
      await withIntegrationFixture('execution-preparation-control-failure', async (fixture) => {
        const chatId = fixture.newChatId();
        const sourceChatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic target input' });
        const source = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic source input' });
        const next = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic queued input' });
        let validation: ReturnType<typeof gate.holdNext> | undefined;
        try {
          const started = await fixture.client.startDirectChat({ chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic target input' });
          await first.received;
          await fixture.client.enqueueNew(chatId, 'synthetic queued input');
          const paused = await fixture.client.pauseQueue(chatId);
          await fixture.client.startDirectChat({ chatId: sourceChatId, agent, projectPath: fixture.dirs.project, content: 'synthetic source input' });
          await source.received;
          source.releaseText(`<garcon-send-message to="${chatId}" hide-sender="false">\nsynthetic rejected control\n</garcon-send-message>`);
          await fixture.client.waitForEvent(
            (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === sourceChatId
              && event.messages.some(({ message }) => message.type === 'transcript-notice'
                && message.detail?.type === 'inter-agent-message-outcome'),
            'queued control receipt',
          );
          validation = gate.holdNext();
          first.releaseText('synthetic initial response');
          await fixture.client.waitForTurnTerminal(chatId, started.turnId);
          await fixture.client.resumeQueue(chatId, paused.control.queue.pause!.id);
          await withTimeout(validation.entered.promise, 5_000, () => 'Control preparation did not reach validation');
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
          validation.release.resolve(false);
          await withTimeout(next.received, 5_000, () => 'Rejected control blocked the queued user input');
          const afterIndex = fixture.client.markEvents();
          next.releaseText('synthetic queued response');
          await fixture.client.waitForProcessing(chatId, false, { afterIndex });
          expect(userContents((await fixture.client.getMessages(chatId)).messages))
            .toEqual(['synthetic target input', 'synthetic queued input']);
          const control = await fixture.client.getExecutionControl(chatId);
          expect(control.queue.entries).toEqual([]);
          expect(control.queue.pause).toBeNull();
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(3);
        } finally {
          validation?.release.resolve(false);
          for (const held of [first, source, next]) { held.allowAbort(); held.releaseText('synthetic cleanup'); }
        }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-configuration-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_CONFIGURATION_GATE: gate.url },
      });
    } finally { await gate.close(); }
  }, 30_000);

  test('Stop cancels queued preparation even when the queue is resumed before validation returns', async () => {
    const gate = validationGate();
    try {
      await withIntegrationFixture('execution-preparation-stop', async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic first input' });
        const next = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic queued input' });
        let oldValidation: ReturnType<typeof gate.holdNext> | undefined;
        let freshValidation: ReturnType<typeof gate.holdNext> | undefined;
        try {
          await fixture.client.startDirectChat({ chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic first input' });
          await first.received;
          await fixture.client.enqueueNew(chatId, 'synthetic queued input');
          oldValidation = gate.holdNext();
          first.releaseText('synthetic first response');
          await withTimeout(oldValidation.entered.promise, 5_000, () => 'Queued preparation did not reach validation');
          const stopped = await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() });
          expect(stopped.control.queue.pause).not.toBeNull();
          await fixture.client.resumeQueue(chatId, stopped.control.queue.pause!.id);
          freshValidation = gate.holdNext();
          oldValidation.release.resolve(true);
          await withTimeout(freshValidation.entered.promise, 5_000, () => 'Resuming reused the cancelled preparation');
          expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['synthetic first input']);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
          freshValidation.release.resolve(true);
          await next.received;
          const afterIndex = fixture.client.events().length;
          next.releaseText('synthetic queued response');
          await fixture.client.waitForProcessing(chatId, false, { afterIndex });
          expect(userContents((await fixture.client.getMessages(chatId)).messages))
            .toEqual(['synthetic first input', 'synthetic queued input']);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
        } finally {
          oldValidation?.release.resolve(false);
          freshValidation?.release.resolve(false);
          first.releaseText('synthetic cleanup');
          next.releaseText('synthetic cleanup');
        }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-configuration-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_CONFIGURATION_GATE: gate.url },
      });
    } finally { await gate.close(); }
  }, 30_000);

  test('reserves start capacity while another chat is still validating its configuration', async () => {
    const gate = validationGate();
    try {
      await withIntegrationFixture('execution-preparation-capacity', async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const validation = gate.holdNext();
        const first = fixture.client.startDirectChat({ chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic first input' });
        void first.catch(() => {});
        try {
          await withTimeout(validation.entered.promise, 5_000, () => 'The first start did not reach validation');
          await expect(fixture.client.startDirectChat({ chatId: fixture.newChatId(), agent,
            projectPath: fixture.dirs.project, content: 'synthetic excess input',
          })).rejects.toMatchObject({ status: 429 });
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
          validation.release.resolve(true);
          await fixture.client.waitForTurnTerminal(chatId, (await first).turnId);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
        } finally { validation.release.resolve(false); await first.catch(() => {}); }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-configuration-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_CONFIGURATION_GATE: gate.url, GARCON_MAX_SESSIONS: '1' },
      });
    } finally { await gate.close(); }
  }, 30_000);

  test('persists settings only after provider validation, preserves rejected settings, and resumes after restart', async () => {
    const gate = validationGate();
    try {
      await withIntegrationFixture('configuration-settings-persistence', async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const started = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic initial input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const history = await fixture.client.getMessages(chatId);
        await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: agent.agentId });
        const original = await persistedChat(fixture, chatId);
        for (const accepted of [false, true]) {
          const validation = gate.holdNext();
          const pending = fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
            chatId, permissionMode: 'bypassPermissions', thinkingMode: 'none', agentSettingsPatch: {},
          });
          void pending.catch(() => undefined);
          try {
            await withTimeout(validation.entered.promise, 5_000, () => 'Settings did not enter provider validation');
            expect(await persistedChat(fixture, chatId)).toEqual(original);
            expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
            validation.release.resolve(accepted);
            if (accepted) {
              expect(await pending).toMatchObject({
                success: true, chatId, permissionMode: 'bypassPermissions', thinkingMode: 'none',
                agentSettings: agent.agentSettings,
              });
            } else {
              await expect(pending).rejects.toMatchObject({ status: 500, body: { errorCode: 'INTERNAL_ERROR' } });
              expect(await persistedChat(fixture, chatId)).toEqual(original);
            }
          } finally {
            validation.release.resolve(false);
            await pending.catch(() => undefined);
          }
        }
        const saved = await persistedChat(fixture, chatId);
        expect(saved).toMatchObject({
          permissionMode: 'bypassPermissions', thinkingMode: 'none',
          agentSessionId: original.agentSessionId, executionLocation: original.executionLocation,
        });
        expect(await fixture.client.getMessages(chatId)).toEqual(history);
        await fixture.restartGarcon();
        expect(await persistedChat(fixture, chatId)).toEqual(saved);
        expect(await fixture.client.getMessages(chatId)).toEqual(history);
        const resumed = await fixture.client.runChat({
          chatId, command: 'synthetic persisted configuration input',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        });
        await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
        expect(parseAgentTurnReceipt(await fixture.client.get(
          `/api/v1/chats/turn-receipt?chatId=${chatId}&turnId=${resumed.turnId}`,
        ))).toMatchObject({ state: 'completed' });
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
        expect(fixture.fakeProviders.openAi.requests()[1]?.body.reasoning_effort).toBeUndefined();
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-configuration-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_CONFIGURATION_GATE: gate.url },
      });
    } finally { await gate.close(); }
  }, 30_000);

  test('rejects a settings update when journal recovery replaces its owner during validation', async () => {
    const gate = validationGate();
    try {
      await withIntegrationFixture('configuration-recovered-owner', async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startDirectChat({
          chatId, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project,
          content: 'synthetic source input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const modePath = join(fixture.dirs.root, 'journal-fault-mode');
        await writeFile(modePath, 'decision');
        try {
          await expect(fixture.client.handoffDirectChat({
            chatId, agent: fixture.directAgents.anthropic, content: 'synthetic rejected handoff input',
          })).rejects.toMatchObject({ status: 409, body: { errorCode: 'OWNERSHIP_TRANSFER_PENDING' } });
          const validation = gate.holdNext();
          const pending = fixture.client.patch('/api/v1/chats/execution-settings', {
            chatId, permissionMode: 'bypassPermissions', thinkingMode: 'none', agentSettingsPatch: {},
          }).then(() => null, (error: unknown) => error);
          try {
            await withTimeout(validation.entered.promise, 5_000, () => 'Settings did not enter provider validation');
            await writeFile(modePath, 'none');
            await fixture.client.waitForEvent(
              (event): event is ChatListRefreshRequestedMessage => event.type === 'chat-list-refresh-requested'
                && event.reason === 'agent-handoff' && event.chatId === chatId,
              'handoff recovered during settings validation',
            );
            const recovered = await persistedChat(fixture, chatId);
            expect(recovered.agentId).toBe(fixture.directAgents.anthropic.agentId);
            expect(recovered.permissionMode).toBe('default');
            validation.release.resolve(true);
            expect(await pending).toMatchObject({ status: 409, body: { errorCode: 'SOURCE_REVISION_CHANGED' } });
            expect(await persistedChat(fixture, chatId)).toEqual(recovered);
          } finally {
            validation.release.resolve(false);
            await pending;
          }
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
          expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(0);
          const history = await fixture.client.getMessages(chatId);
          expect(history.messages.filter((row) => row.message.type === 'agent-switch')).toHaveLength(1);
        } finally { await writeFile(modePath, 'none'); }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: ['provider-configuration-preload.ts', 'journal-durability-preload.ts'].map((name) =>
          fileURLToPath(new URL(`../../support/${name}`, import.meta.url))),
        resolveServerEnvironment: (directories) => ({
          GARCON_TEST_CONFIGURATION_GATE: gate.url, GARCON_TEST_JOURNAL_FAULT_DIR: directories.root,
        }),
      });
    } finally { await gate.close(); }
  }, 30_000);

  test('keeps settings unchanged on unknown application and persists only a confirmed instance result', async () => {
    const gate = sessionApplicationGate();
    try {
      await withIntegrationFixture('configuration-application-outcome', async (fixture) => {
        const chatId = fixture.newChatId();
        const agent = fixture.directAgents.openAi;
        const started = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'synthetic initial input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: agent.agentId });
        const original = await persistedChat(fixture, chatId);
        const history = await fixture.client.getMessages(chatId);
        for (const kind of ['unknown', 'applied'] as const) {
          const application = gate.holdNext();
          const pending = fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
            chatId, permissionMode: 'bypassPermissions', thinkingMode: 'none', agentSettingsPatch: {},
          });
          void pending.catch(() => undefined);
          try {
            expect(await withTimeout(application.entered.promise, 5_000, () => 'Settings did not reach the instance service'))
              .toMatchObject({
                expected: { agentSessionId: original.agentSessionId, nativeSession: original.nativeSession, projectPath: fixture.dirs.project },
                previous: { model: agent.provider.model, permissionMode: 'default' },
                next: { model: agent.provider.model, permissionMode: 'bypassPermissions' },
              });
            expect(await persistedChat(fixture, chatId)).toEqual(original);
            application.release.resolve({ kind });
            if (kind === 'unknown') {
              await expect(pending).rejects.toMatchObject({
                status: 504, body: { errorCode: 'SESSION_SETTINGS_OUTCOME_UNKNOWN', retryable: false },
              });
              expect(await persistedChat(fixture, chatId)).toEqual(original);
            } else {
              expect(await pending).toMatchObject({ success: true, chatId, permissionMode: 'bypassPermissions' });
            }
          } finally {
            application.release.resolve({ kind: 'unknown' });
            await pending.catch(() => undefined);
          }
          expect(gate.calls()).toBe(kind === 'unknown' ? 1 : 2);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
          expect(await fixture.client.getMessages(chatId)).toEqual(history);
        }
        const saved = await persistedChat(fixture, chatId);
        expect(saved).toMatchObject({ permissionMode: 'bypassPermissions' });
        await fixture.restartGarcon();
        expect(await persistedChat(fixture, chatId)).toEqual(saved);
        expect(await fixture.client.getMessages(chatId)).toEqual(history);
        expect(gate.calls()).toBe(2);
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/provider-session-configuration-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_SESSION_CONFIGURATION_GATE: gate.url },
      });
    } finally { await gate.close(); }
  }, 30_000);
});

async function persistedChat(fixture: IntegrationFixture, chatId: string) {
  const registry: unknown = JSON.parse(await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'));
  if (!isRecord(registry) || !isRecord(registry.sessions) || !isRecord(registry.sessions[chatId])) {
    throw new Error('Invalid synthetic registry');
  }
  return registry.sessions[chatId];
}

function validationGate() {
  type HeldValidation = { entered: Deferred<unknown>; release: Deferred<boolean> };
  let next: HeldValidation | null = null;
  const held = new Set<HeldValidation>();
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0, idleTimeout: 0,
    async fetch(request) {
      const validation = next;
      next = null;
      if (!validation) return new Response(null, { status: 204 });
      validation.entered.resolve(await request.json());
      const accepted = await validation.release.promise;
      held.delete(validation);
      return new Response(null, { status: accepted ? 204 : 422 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    holdNext() {
      if (next) throw new Error('Validation barrier already armed');
      next = { entered: new Deferred<unknown>(), release: new Deferred<boolean>() };
      held.add(next);
      return next;
    },
    async close() {
      for (const validation of held) validation.release.resolve(false);
      await server.stop(true);
    },
  };
}

function sessionApplicationGate() {
  type HeldApplication = { entered: Deferred<ProviderSessionConfigurationRequest>; release: Deferred<ProviderSessionConfigurationResult> };
  let next: HeldApplication | null = null;
  let calls = 0;
  const held = new Set<HeldApplication>();
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    async fetch(request) {
      calls++;
      const application = next;
      next = null;
      if (!application) return Response.json({ kind: 'unknown' } satisfies ProviderSessionConfigurationResult);
      application.entered.resolve(await request.json());
      const result = await application.release.promise;
      held.delete(application);
      return Response.json(result);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls: () => calls,
    holdNext() {
      if (next) throw new Error('Application barrier already armed');
      next = { entered: new Deferred<ProviderSessionConfigurationRequest>(), release: new Deferred<ProviderSessionConfigurationResult>() };
      held.add(next);
      return next;
    },
    async close() {
      for (const application of held) application.release.resolve({ kind: 'unknown' });
      await server.stop(true);
    },
  };
}
