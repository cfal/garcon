import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiProviderCatalogEntry } from '../../../common/api-providers.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { runCli, withCliFixture } from '../../support/cli-fixture.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { codexRequestModel, liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('refuses a saved Codex provider mismatch without replacing its session or losing readable history', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    await withIntegrationFixture('codex-scripted-provider-admission', async (fixture) => {
      const chatId = fixture.newChatId();
      const answer = 'Synthetic answer owned by the original provider.';
      environment.model.scriptTurn([codexAssistantMessage(answer)]);
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'Start a synthetic provider-bound session.',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: started.turnId, marker: answer, afterIndex: cursor });
      const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
      const configPath = join(fixture.executionDirs.home, '.codex', 'config.toml');
      const originalConfig = await readFile(configPath, 'utf8');
      const alternateConfig = [
        originalConfig.replace(/^model_provider = .*$/m, 'model_provider = "synthetic-alternate-429"'),
        '[model_providers.synthetic-alternate-429]',
        'name = "Synthetic alternate"',
        `base_url = ${JSON.stringify(`${environment.proxyBaseUrl}/v1`)}`,
        'wire_api = "responses"',
        '',
      ].join('\n');
      await fixture.restartGarcon({ beforeStart: () => writeFile(configPath, alternateConfig) });

      const failureCursor = fixture.client.markEvents();
      const failed = await fixture.client.runChat(liveCodexRunRequest({
        chatId, command: 'Do not move this session to another provider.',
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, failed.turnId, { afterIndex: failureCursor });
      expect(terminal).toMatchObject({
        type: 'agent-run-failed',
        error: 'Codex error: This chat uses garcon-live-testing, but your current provider is synthetic-alternate-429. Switch to garcon-live-testing to continue.',
      });
      expect(environment.model.requests()).toHaveLength(1);
      await fixture.client.reloadChat(chatId);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toEqual([answer]);
      const preserved = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
      expect(preserved.agentSessionId).toBe(native.agentSessionId);
      expect(preserved.nativeSession).toEqual(native.nativeSession);

      await fixture.restartGarcon({ beforeStart: () => writeFile(configPath, originalConfig) });
      const restoredAnswer = 'Synthetic answer after restoring the original provider.';
      environment.model.scriptTurn([codexAssistantMessage(restoredAnswer)]);
      const restoredCursor = fixture.client.markEvents();
      const restored = await fixture.client.runChat(liveCodexRunRequest({
        chatId, command: 'Continue on the original synthetic provider.',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: restored.turnId, marker: restoredAnswer, afterIndex: restoredCursor,
      });
      expect(environment.model.requests()).toHaveLength(2);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toEqual([answer, restoredAnswer]);
      const resumed = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
      expect(resumed.agentSessionId).toBe(native.agentSessionId);
      environment.model.assertSettled();
    }, environment);
  } finally {
    await environment.dispose();
  }
}, 120_000);

test.each(['paginated', 'legacy'] as const)('preserves endpoint-bound Codex sessions across settings and turn refusals, restart, and fork (%s)', async (historyMode) => {
  const environment = await startScriptedCodexTestEnvironment();
  const receivedProviders: string[] = [];
  const headerSecret = 'synthetic-dotted-header-secret';
  const endpoints = ['original', 'alternate'].map((provider) => Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch(request) {
      receivedProviders.push(provider);
      if (request.headers.get('X.Gateway.Key') !== headerSecret
        || !request.headers.has('X.Empty.Header') || request.headers.get('X.Empty.Header') !== '') {
        return new Response('Missing synthetic gateway header', { status: 403 });
      }
      return fetch(new Request(new URL(new URL(request.url).pathname, environment.proxyBaseUrl), request));
    },
  }));
  try {
    await withCliFixture('codex-scripted-endpoint-admission', async (fixture) => {
      const providers: ApiProviderCatalogEntry[] = [];
      for (const [index, label] of ['Synthetic original', 'Synthetic alternate'].entries()) {
        providers.push(await fixture.client.post<ApiProviderCatalogEntry>(`/api/v1/api-providers?executorId=${fixture.client.executorId}`, {
          templateId: 'custom', label,
          endpoint: {
            protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${endpoints[index]!.port}/v1`,
            apiKey: 'synthetic-endpoint-key', capabilities: { chatCompletions: false, responses: true },
            defaultModel: codexRequestModel(), models: [{ value: codexRequestModel(), label: 'Synthetic model' }],
            supportsImages: false,
          },
        }));
      }
      const original = providers[0]!;
      const alternate = providers[1]!;
      const originalEndpointId = original.endpoints[0]!.id;
      const alternateEndpointId = alternate.endpoints[0]!.id;
      await fixture.restartGarcon({ beforeStart: async () => {
        const path = join(fixture.dirs.config, 'api-providers.json');
        const config = JSON.parse(await readFile(path, 'utf8'));
        for (const provider of config.apiProviders) {
          if (providers.some((entry) => entry.id === provider.id)) {
            provider.endpoints[0].headers = { 'X.Gateway.Key': headerSecret, 'X.Empty.Header': '' };
          }
        }
        await writeFile(path, JSON.stringify(config));
      } });
      const chatId = fixture.newChatId();
      const answer = 'Synthetic answer on the selected endpoint.';
      environment.model.scriptTurn([codexAssistantMessage(answer)]);
      const cursor = fixture.client.markEvents();
      const started = await fixture.client.startChat({
        ...liveCodexStartRequest({ chatId, projectPath: fixture.executionDirs.project, command: 'Start on the original endpoint.' }),
        apiProviderId: original.id, modelEndpointId: originalEndpointId,
      });
      await waitForVisibleResponse({ fixture, chatId, turnId: started.turnId, marker: answer, afterIndex: cursor });
      const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
      let requestCount = 1;

      for (const restart of [false, true]) {
        if (restart) {
          await fixture.restartGarcon({ beforeStart: async () => {
            if (historyMode !== 'legacy') return;
            // Exercises the supported legacy JSONL fork path, not the paginated projection.
            const path = String(native.nativeSession!.value.path);
            const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
            const metadata = JSON.parse(lines[0]!);
            metadata.payload.history_mode = 'legacy';
            delete metadata.payload.history_base;
            lines[0] = JSON.stringify(metadata);
            await writeFile(path, `${lines.join('\n')}\n`);
          } });
          await fixture.client.reloadChat(chatId);
          const source = await fixture.client.getMessages(chatId);
          const sourcePath = String(native.nativeSession!.value.path);
          const originalHistory = await readFile(sourcePath, 'utf8');
          for (const selection of [
            { apiProviderId: alternate.id, modelEndpointId: alternateEndpointId },
            { apiProviderId: null, modelEndpointId: null },
          ]) {
            await fixture.client.patch('/api/v1/chats/model', {
              chatId, model: codexRequestModel(), ...selection,
            });
            for (const point of [undefined, source.messages.at(-1)!.ordinal]) {
              const target = fixture.newChatId();
              expect(await rejectionOf(fixture.client.forkChat({
                sourceChatId: chatId, chatId: target, allowHandoffFork: true,
                ...(point ? { transcriptViewId: source.transcriptViewId, upToOrdinal: point } : {}),
              }))).toMatchObject({ status: 422, body: { errorCode: 'INVALID_ENDPOINT' } });
              expect((await fixture.client.listChats()).sessions.some((entry) => entry.id === target)).toBe(false);
            }
            const beforeCli = (await fixture.client.listChats()).sessions.length;
            const runtimes = fixture.client.executorId === 'local'
              ? ['controller'] as const : ['controller', 'executor'] as const;
            for (const runtime of runtimes) {
              const refused = await runCli(fixture, ['fork', chatId, '--allow-handoff-fork'], runtime);
              expect(refused).toMatchObject({ exitCode: 3, stdout: '' });
              expect(refused.stderr).toContain('HTTP 422, INVALID_ENDPOINT');
            }
            expect((await fixture.client.listChats()).sessions).toHaveLength(beforeCli);
          }
          expect(await readFile(sourcePath, 'utf8')).toBe(originalHistory);
          await fixture.restartGarcon();
          const mismatchedCursor = fixture.client.markEvents();
          const mismatched = await fixture.client.runChat(liveCodexRunRequest({
            chatId, command: 'Refuse mismatched saved settings without loading a native source.',
          }));
          expect(await fixture.client.waitForTurnTerminal(chatId, mismatched.turnId, { afterIndex: mismatchedCursor }))
            .toMatchObject({ type: 'agent-run-failed', error: expect.stringContaining('original endpoint') });
          expect(environment.model.requests()).toHaveLength(requestCount);
          const repairAnswer = 'Synthetic original-endpoint override before settings repair.';
          environment.model.scriptTurn([codexAssistantMessage(repairAnswer)]);
          const repairCursor = fixture.client.markEvents();
          const repair = await fixture.client.runChat({
            ...liveCodexRunRequest({ chatId, command: 'Load the original endpoint without changing saved settings.' }),
            apiProviderId: original.id, modelEndpointId: originalEndpointId,
          });
          await waitForVisibleResponse({ fixture, chatId, turnId: repair.turnId, marker: repairAnswer, afterIndex: repairCursor });
          requestCount += 1;
          await fixture.client.patch('/api/v1/chats/model', {
            chatId, model: codexRequestModel(), apiProviderId: original.id, modelEndpointId: originalEndpointId,
          });
        } else {
          expect(await rejectionOf(fixture.client.patch('/api/v1/chats/model', {
            chatId, model: codexRequestModel(), apiProviderId: alternate.id, modelEndpointId: alternateEndpointId,
          }))).toMatchObject({ status: 422, body: { errorCode: 'INVALID_ENDPOINT', error: expect.stringContaining('Start a new chat') } });
        }
        expect((await fixture.client.listChats()).sessions.find((entry) => entry.id === chatId)).toMatchObject({
          apiProviderId: original.id, modelEndpointId: originalEndpointId,
        });
        const preserved = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
        expect(preserved.agentSessionId).toBe(native.agentSessionId);
        expect(preserved.nativeSession).toEqual(native.nativeSession);
        expect(environment.model.requests()).toHaveLength(requestCount);

        const overrideCursor = fixture.client.markEvents();
        const overridden = await fixture.client.runChat({
          ...liveCodexRunRequest({ chatId, command: 'Do not override the native provider for this turn.' }),
          apiProviderId: alternate.id, modelEndpointId: alternateEndpointId,
        });
        expect(await fixture.client.waitForTurnTerminal(chatId, overridden.turnId, { afterIndex: overrideCursor })).toMatchObject({
          type: 'agent-run-failed', error: expect.stringContaining('Start a new chat to use a different endpoint'),
        });
        expect(environment.model.requests()).toHaveLength(requestCount);
        expect((await fixture.client.listChats()).sessions.find((entry) => entry.id === chatId)).toMatchObject({
          apiProviderId: original.id, modelEndpointId: originalEndpointId,
        });
      }

      const continuedAnswer = 'Synthetic continuation on the unchanged endpoint.';
      environment.model.scriptTurn([codexAssistantMessage(continuedAnswer)]);
      const continuedCursor = fixture.client.markEvents();
      const continued = await fixture.client.runChat(liveCodexRunRequest({ chatId, command: 'Continue on the original endpoint.' }));
      await waitForVisibleResponse({ fixture, chatId, turnId: continued.turnId, marker: continuedAnswer, afterIndex: continuedCursor });
      expect(environment.model.requests()).toHaveLength(requestCount + 1);
      expect((await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' })).agentSessionId).toBe(native.agentSessionId);

      const childChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId: chatId, chatId: childChatId });
      const childNative = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId: childChatId, agentId: 'codex' });
      expect(childNative.agentSessionId).not.toBe(native.agentSessionId);
      const childAnswer = 'Synthetic continuation of the endpoint-bound fork.';
      environment.model.scriptTurn((request) => {
        expect(JSON.stringify(request.body)).toContain(continuedAnswer);
        return [codexAssistantMessage(childAnswer)];
      });
      const childCursor = fixture.client.markEvents();
      const child = await fixture.client.runChat(liveCodexRunRequest({ chatId: childChatId, command: 'Continue the endpoint-bound fork.' }));
      await waitForVisibleResponse({ fixture, chatId: childChatId, turnId: child.turnId, marker: childAnswer, afterIndex: childCursor });
      expect(environment.model.requests()).toHaveLength(requestCount + 2);
      expect(receivedProviders).toEqual(Array(requestCount + 2).fill('original'));
      expect(fixture.describe()).not.toContain(headerSecret);
      environment.model.assertSettled();
    }, environment);
  } finally {
    for (const endpoint of endpoints) endpoint.stop(true);
    await environment.dispose();
  }
}, 120_000);
