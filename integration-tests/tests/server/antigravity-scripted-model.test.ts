import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAuthStatus } from '../../../common/agent-execution.js';
import { CATALOG_INSTANCE_HEADER, type ModelCatalogResponse } from '../../../common/model-catalog.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import {
  FAKE_GEMINI_API_KEY,
  FakeGeminiModel,
  geminiFunctionCall,
  geminiText,
  geminiThought,
} from '../../support/fake-gemini-model.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import {
  ANTIGRAVITY_BINARY,
  ANTIGRAVITY_TEST_ALTERNATE_MODEL,
  ANTIGRAVITY_TEST_MODEL,
  antigravityAgentSessionId,
  antigravityUpdaterSpawns,
  scriptedAntigravityRunRequest,
  scriptedAntigravityStartRequest,
  startScriptedAntigravityTestEnvironment,
  type ScriptedAntigravityTestEnvironment,
} from '../../support/scripted-antigravity.js';

const TURN_TIMEOUT_MS = 120_000;

let environment: ScriptedAntigravityTestEnvironment | undefined;

function requireEnvironment(): ScriptedAntigravityTestEnvironment {
  if (!environment) throw new Error('Scripted Antigravity environment was not started.');
  return environment;
}

function withScriptedAntigravity() {
  const current = requireEnvironment();
  return { serverEnvironment: current.serverEnvironment, prepareWorkspace: current.prepareWorkspace };
}

function marker(name: string): string {
  return `${name}_${crypto.randomUUID().slice(0, 8)}`;
}

test('a failed agy listing offers Default for selection but does not confirm login discovery', async () => {
  await withIntegrationFixture('antigravity-discovery-unavailable', async ({ client }) => {
    const query = new URLSearchParams({ executorId: client.executorId });
    const ordinary = await client.fetch(`/api/v1/models?${query}`);
    expect(ordinary.status).toBe(200);
    const { catalog } = await ordinary.json() as ModelCatalogResponse;
    expect(catalog.agents.find(agent => agent.id === 'antigravity')?.models)
      .toEqual([expect.objectContaining({ value: 'default' })]);

    const instance = ordinary.headers.get(CATALOG_INSTANCE_HEADER);
    if (!instance) throw new Error('Catalog response omitted its serving instance');
    query.set('loginInstance', instance);
    query.set('loginAgent', 'antigravity');
    expect(await rejectionOf(client.get(`/api/v1/models?${query}`))).toMatchObject({
      status: 503, body: { errorCode: 'MODEL_DISCOVERY_UNAVAILABLE', retryable: true },
    });
  }, {
    resolveServerEnvironment: dirs => ({ GARCON_ANTIGRAVITY_BINARY: join(dirs.home, 'unavailable-agy') }),
    async prepareWorkspace(dirs) {
      await writeFile(join(dirs.home, 'unavailable-agy'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    },
  });
}, TURN_TIMEOUT_MS);

test('keeps healthy models available if agy disappears after credentials are confirmed', async () => {
  await withIntegrationFixture('antigravity-disappearing-cli', async ({ client, executionDirs }) => {
    const query = new URLSearchParams({ executorId: client.executorId });
    const healthy = await client.fetch(`/api/v1/models?agent=codex&${query}`);
    const instance = healthy.headers.get(CATALOG_INSTANCE_HEADER);
    if (!instance) throw new Error('Codex catalog omitted its serving instance');
    const healthyModels = (await healthy.json() as ModelCatalogResponse).catalog.agents[0]?.models;
    expect(healthyModels?.length).toBeGreaterThan(0);
    query.set('loginInstance', instance);
    const auth = await client.get<Record<string, AgentAuthStatus>>(`/api/v1/agents/auth?agent=antigravity&${query}`);
    expect(auth.antigravity?.authenticated).toBe(true);
    await unlink(join(executionDirs.home, 'removable-agy'));
    query.append('loginAgent', 'codex');
    query.append('loginAgent', 'antigravity');
    const reply = await client.fetch(`/api/v1/models?${query}`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get(CATALOG_INSTANCE_HEADER)).toBe(instance);
    const { catalog } = await reply.json() as ModelCatalogResponse;
    expect(catalog.agents.find(agent => agent.id === 'antigravity')?.models).toEqual([]);
    expect(catalog.agents.find(agent => agent.id === 'codex')?.models).toEqual(healthyModels);
  }, {
    executorEnvironment: { GEMINI_API_KEY: FAKE_GEMINI_API_KEY, GARCON_ANTIGRAVITY_AUTH_METHOD: 'gemini-api-key' },
    resolveServerEnvironment: dirs => ({ GARCON_ANTIGRAVITY_BINARY: join(dirs.home, 'removable-agy') }),
    async prepareWorkspace(dirs) {
      await writeFile(join(dirs.home, 'removable-agy'), '#!/bin/sh\n[ "$1" = --version ]\n', { mode: 0o700 });
    },
  });
}, TURN_TIMEOUT_MS);

test('retries post-login discovery after temporary spawn pressure on the executor', async () => {
  await withIntegrationFixture('antigravity-spawn-pressure', async ({ client, executionDirs }) => {
    const query = new URLSearchParams({ executorId: client.executorId });
    const ordinary = await client.fetch(`/api/v1/models?${query}`);
    const instance = ordinary.headers.get(CATALOG_INSTANCE_HEADER);
    if (!instance) throw new Error('Catalog response omitted its serving instance');
    const { catalog } = await ordinary.json() as ModelCatalogResponse;
    query.set('loginInstance', instance);
    query.set('loginAgent', 'antigravity');
    const route = `/api/v1/models?${query}`;
    const failed = await client.fetch(route);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ errorCode: 'MODEL_DISCOVERY_UNAVAILABLE', retryable: true });
    expect(catalog.agents.find(agent => agent.id === 'antigravity')?.models.map(model => model.value)).toEqual(['default']);

    await unlink(join(executionDirs.home, 'fixture-agy.busy'));
    const retried = await client.get<ModelCatalogResponse>(route);
    expect(retried.catalog.agents.find(agent => agent.id === 'antigravity')?.models.map(model => model.value))
      .toEqual(['default', 'fixture-model']);
  }, {
    resolveServerEnvironment: dirs => ({ GARCON_ANTIGRAVITY_BINARY: join(dirs.home, 'fixture-agy') }),
    executorEnvironment: { BUN_OPTIONS: `--preload=${fileURLToPath(new URL('../../support/antigravity-spawn-pressure.ts', import.meta.url))}` },
    async prepareWorkspace(dirs) {
      const binary = join(dirs.home, 'fixture-agy');
      await writeFile(binary, "#!/bin/sh\nprintf 'fixture-model\\tFixture model\\n'\n", { mode: 0o700 });
      await writeFile(`${binary}.busy`, '');
    },
  });
}, TURN_TIMEOUT_MS);

describe.skipIf(!ANTIGRAVITY_BINARY)('scripted Antigravity', () => {
  beforeEach(() => {
    environment = startScriptedAntigravityTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('lists the account models from agy and reports API-key authentication', async () => {
    await withIntegrationFixture('antigravity-scripted-catalog', async (fixture) => {
      const catalog = await fixture.client.listAgentCatalog();
      const antigravity = catalog.agents.find((agent) => agent.id === 'antigravity');
      if (!antigravity) throw new Error('Antigravity was not listed in the catalog.');
      expect(antigravity.defaultModel).toBe('default');
      expect(antigravity.models[0]).toMatchObject({ value: 'default', label: 'Default' });
      expect(antigravity.models.map((model) => model.value)).toEqual(
        expect.arrayContaining([ANTIGRAVITY_TEST_MODEL, ANTIGRAVITY_TEST_ALTERNATE_MODEL]),
      );
      expect(antigravity.models.find((model) => model.value === ANTIGRAVITY_TEST_MODEL)?.label)
        .toBe('Gemini 3.1 Pro (Low)');
      expect(antigravity.authLoginSupported).toBe(true);
      expect(antigravity.supportsSteering).toBe(false);
      const authUrl = `/api/v1/agents/auth?agent=antigravity&executorId=${encodeURIComponent(fixture.client.executorId)}`;
      const retired = await rejectionOf(fixture.client.get(`${authUrl}&loginInstance=retired-test-worker`));
      expect(retired).toMatchObject({ status: 409, body: { errorCode: 'LOGIN_INSTANCE_CHANGED' } });
      const auth = await fixture.client.get<Record<string, AgentAuthStatus>>(authUrl);
      expect(auth.antigravity).toMatchObject({
        authenticated: true, canReauth: false, label: 'GEMINI_API_KEY', source: 'environment',
      });
      if (fixture.client.executorId !== 'local') {
        const local = await fixture.client.get<Record<string, AgentAuthStatus>>(
          '/api/v1/agents/auth?agent=antigravity&executorId=local',
        );
        expect(local.antigravity).toMatchObject({ authenticated: false, source: 'none' });
      }
      // agy honors only AGY_CLI_DISABLE_AUTO_UPDATE=true; any other value lets
      // `agy models` start the updater, which replaced the pinned binary.
      expect(await antigravityUpdaterSpawns(fixture.executionDirs)).toBe(0);
      requireEnvironment().model.assertSettled();
    }, {
      ...withScriptedAntigravity(),
      serverEnvironment: {
        ...requireEnvironment().serverEnvironment, GARCON_ANTIGRAVITY_AUTH_METHOD: 'gemini-api-key', GEMINI_API_KEY: '',
      },
      executorEnvironment: { GEMINI_API_KEY: FAKE_GEMINI_API_KEY },
    });
  }, TURN_TIMEOUT_MS);

  test('runs the native Default when a fresh API-key account has no discovered models', async () => {
    const { model, serverEnvironment } = requireEnvironment();
    const reply = marker('DEFAULT_REPLY');
    model.scriptTurn([geminiText(reply)]);
    // No modelProvider setting: the CLI can run a turn even though `agy models` lists no IDs.
    await withIntegrationFixture('antigravity-scripted-default', async (fixture) => {
      const catalog = await fixture.client.listAgentCatalog();
      const agent = catalog.agents.find((entry) => entry.id === 'antigravity');
      if (!agent) throw new Error('Antigravity was not listed in the catalog.');
      expect(agent.models).toEqual([expect.objectContaining({ value: 'default', label: 'Default' })]);
      expect(agent.defaultModel).toBe('default');

      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'use the native default', model: agent.defaultModel,
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });
      expect(model.requests()).toMatchObject([{
        model: 'gemini-3.1-pro-preview', body: { generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } },
      }]);
      model.assertSettled();
    }, { serverEnvironment });
  }, TURN_TIMEOUT_MS);

  test('keeps an answer whole when the model interleaves thought parts with it', async () => {
    const { model } = requireEnvironment();
    const hash = marker('HASH');
    const half = Math.floor(hash.length / 2);
    // Each text boundary falls inside Markdown, as a streamed answer's can.
    model.scriptPacedTurn([
      geminiThought('Checking the merge.'),
      geminiText('- **Merged:** at `'),
      geminiThought(' Then the deploy.'),
      geminiText(hash.slice(0, half)),
      geminiThought(' Then the status.'),
      geminiText(`${hash.slice(half)}\`.\n- **Deployed:** **Not`),
      geminiThought(' Done.'),
      geminiText(' started**.'),
    ], 50);
    await withIntegrationFixture('antigravity-scripted-interleaved-thought', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'summarize the release',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor });
      const messages = (await fixture.client.getMessages(chatId)).messages;
      expect(assistantContents(messages)).toEqual([`- **Merged:** at \`${hash}\`.\n- **Deployed:** **Not started**.`]);
      expect(messagesOfType(messages, 'thinking').map((message) => message.content))
        .toEqual(['Checking the merge. Then the deploy. Then the status. Done.']);
      model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('offers no selectable models when the executor lacks agy', async () => {
    await withIntegrationFixture('antigravity-missing-cli', async ({ client }) => {
      const catalog = await client.listAgentCatalog();
      expect(catalog.agents.find((agent) => agent.id === 'antigravity')?.models).toEqual([]);
    }, { resolveServerEnvironment: (dirs) => ({ GARCON_ANTIGRAVITY_BINARY: join(dirs.home, 'missing-agy') }) });
  }, TURN_TIMEOUT_MS);

  test('refuses a permission change until the first handoff fork prompt binds its session', async () => {
    const env = requireEnvironment();
    env.model.scriptTurn([geminiText('Source reply')]);
    const file = 'fork-permission-result.txt';
    const command = `printf approved > ${file} && cat ${file}`;
    const held = env.model.scriptHeldTurn([geminiFunctionCall('fork-command', 'run_command', {
      CommandLine: command, toolSummary: 'Write a marker', WaitMsBeforeAsync: 5000,
    })]);
    env.model.scriptTurn([geminiText('Fork reply')]);
    await withIntegrationFixture('antigravity-unbound-permission', async (fixture) => {
      const { client } = fixture;
      const sourceChatId = fixture.newChatId();
      const first = await client.startChat(scriptedAntigravityStartRequest({
        chatId: sourceChatId, projectPath: fixture.executionDirs.project,
        command: 'Create a handoff source', permissionMode: 'default',
      }));
      expect((await client.waitForTurnTerminal(sourceChatId, first.turnId)).type).toBe('agent-run-finished');
      const transcript = await client.getMessages(sourceChatId);
      const anchor = transcript.messages.find((row) => row.message.type === 'assistant-message');
      if (!anchor) throw new Error('Missing handoff anchor');
      const chatId = fixture.newChatId();
      await client.forkChat({ sourceChatId, chatId, transcriptViewId: transcript.transcriptViewId, upToOrdinal: anchor.ordinal });
      const gate = join(fixture.executionDirs.home, 'hold-acp');
      await writeFile(gate, '');
      const changeMode = () => client.patch('/api/v1/chats/execution-settings', { chatId, permissionMode: 'default' });
      const cursor = client.markEvents();
      const fork = await client.runChat(scriptedAntigravityRunRequest({ chatId, command: 'Continue', permissionMode: 'bypassPermissions' }));
      try {
        expect(await rejectionOf(changeMode())).toMatchObject({ status: 409, body: { errorCode: 'SESSION_BUSY', retryable: true } });
        expect((await client.getChatSnapshot(chatId)).chat.permissionMode).toBe('default');
      } finally { await unlink(gate); }
      try {
        await withTimeout(held.requested, LIVE_TURN_TIMEOUT_MS, () => 'Fork prompt was not sent');
        await antigravityAgentSessionId(fixture, chatId);
        await changeMode();
        expect((await client.getChatSnapshot(chatId)).chat.permissionMode).toBe('default');
      } finally { held.release(); }
      const permission = await client.waitForTransientPermission(chatId,
        row => row.message.type === 'permission-request' && row.message.requestedTool.type === 'bash-tool-use'
          && row.message.requestedTool.command === command, { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS });
      if (permission.message.type !== 'permission-request') throw new Error('Missing fork permission request');
      const markerFile = Bun.file(join(fixture.executionDirs.project, file));
      expect(await markerFile.exists()).toBe(false);
      await client.sendPermissionDecision({ chatId, clientRequestId: crypto.randomUUID(),
        permissionOccurrenceId: permission.message.permissionOccurrenceId, allow: true, alwaysAllow: false });
      expect((await client.waitForTurnTerminal(chatId, fork.turnId)).type).toBe('agent-run-finished');
      expect(await readFile(join(fixture.executionDirs.project, file), 'utf8')).toBe('approved');
      env.model.assertSettled();
    }, {
      serverEnvironment: { ...env.serverEnvironment, SCRIPTED_AGY: ANTIGRAVITY_BINARY },
      resolveServerEnvironment: (dirs) => ({ GARCON_ANTIGRAVITY_BINARY: join(dirs.home, 'gate-agy') }),
      async prepareWorkspace(dirs) {
        await env.prepareWorkspace(dirs);
        await writeFile(join(dirs.home, 'gate-agy'), [
          '#!/bin/sh',
          'if [ "$1" = acp ]; then while [ -f "$HOME/hold-acp" ]; do sleep 0.05; done; fi',
          'exec "$SCRIPTED_AGY" "$@"', '',
        ].join('\n'), { mode: 0o700 });
      },
    });
  }, TURN_TIMEOUT_MS);

  test('runs an approved command on Default and resumes the same session with another model', async () => {
    const testEnvironment = requireEnvironment();
    const output = marker('COMMAND_OUTPUT');
    const firstReply = marker('FIRST_REPLY');
    const secondPrompt = marker('SECOND_PROMPT');
    const secondReply = marker('SECOND_REPLY');
    const command = `printf %s ${output} > command-output.txt && cat command-output.txt`;
    testEnvironment.model.scriptTurn([
      geminiThought('Planning the command.'),
      geminiFunctionCall('scripted-command', 'run_command', {
        CommandLine: command,
        toolSummary: 'Write and print the marker',
        WaitMsBeforeAsync: 5000,
      }),
    ]);
    testEnvironment.model.scriptTurn((request) => {
      const response = request.functionResponses.find((entry) => entry.id === 'scripted-command');
      expect(JSON.stringify(response?.response)).toContain(output);
      return [geminiText(firstReply)];
    });
    testEnvironment.model.scriptTurn((request) => {
      expect(request.userTexts.some((text) => text.includes(secondPrompt))).toBe(true);
      expect(request.functionResponses.map((entry) => entry.id)).toContain('scripted-command');
      return [geminiText(secondReply)];
    });

    await withIntegrationFixture('antigravity-scripted-command', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'run the scripted command', model: 'default',
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request'
          && row.message.requestedTool.type === 'bash-tool-use'
          && row.message.requestedTool.command === command,
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') throw new Error('Expected a command permission request.');
      expect((await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
      })).status).toBe('accepted');
      await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, marker: firstReply, afterIndex: cursor });

      expect(await readFile(join(fixture.executionDirs.project, 'command-output.txt'), 'utf8')).toBe(output);
      const firstMessages = (await fixture.client.getMessages(chatId)).messages;
      expect(messagesOfType(firstMessages, 'thinking').map((message) => message.content)).toEqual(['Planning the command.']);
      expect(messagesOfType(firstMessages, 'bash-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-command', command, description: 'Write and print the marker' }),
      ]);
      const result = messagesOfType(firstMessages, 'tool-result').find((message) => message.toolId === 'scripted-command');
      expect(result?.isError).toBe(false);
      expect(String(result?.content.raw)).toContain(output);
      expect(String(result?.content.raw)).not.toContain('Created At:');
      const sessionId = await antigravityAgentSessionId(fixture, chatId);

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedAntigravityRunRequest({
        chatId, command: secondPrompt, model: ANTIGRAVITY_TEST_ALTERNATE_MODEL,
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: second.turnId, marker: secondReply, afterIndex: secondCursor });

      expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
      const transcript = (await fixture.client.getMessages(chatId)).messages;
      expect(userContents(transcript)).toEqual(['run the scripted command', secondPrompt]);
      expect(assistantContents(transcript)).toEqual([firstReply, secondReply]);
      const requests = testEnvironment.model.requests();
      // agy 1.5.13 sends the same Gemini model with different thinking budgets for Low and High.
      expect(requests).toMatchObject([1024, 1024, -1].map((thinkingBudget) => ({
        model: 'gemini-3.1-pro-preview', body: { generationConfig: { thinkingConfig: { thinkingBudget } } },
      })));
      expect(await antigravityUpdaterSpawns(fixture.executionDirs)).toBe(0);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('rejects explicit steering and delivers a queued image on the next turn', async () => {
    const { model } = requireEnvironment();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOod9ACAAIrAOpAC706AAAAAElFTkSuQmCC';
    const firstPrompt = marker('FIRST_INPUT');
    const queuedPrompt = marker('IMAGE_INPUT');
    const held = model.scriptHeldTurn([geminiText('First reply')]);
    model.scriptTurn([geminiText('Image reply')]);

    await withIntegrationFixture('antigravity-scripted-queued-image', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: firstPrompt,
      }));
      await withTimeout(held.requested, LIVE_TURN_TIMEOUT_MS, () => 'agy did not dispatch the first turn');
      const cursor = fixture.client.markEvents();
      expect(await rejectionOf(fixture.client.steer({
        chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        content: 'unsupported steer', whenTurnUnavailable: 'queue',
      }))).toMatchObject({ status: 422, body: { errorCode: 'OPERATION_UNSUPPORTED' } });
      const queued = await fixture.client.enqueue({
        chatId, clientRequestId: crypto.randomUUID(), content: queuedPrompt,
        images: [{ name: 'pixel.png', mimeType: 'image/png', data: `data:image/png;base64,${png}` }],
      });
      expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual([queuedPrompt]);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([firstPrompt]);
      expect(model.requests()).toHaveLength(1);

      held.release();
      const terminal = await fixture.client.waitForTurnTerminal(chatId, first.turnId, { afterIndex: cursor });
      expect(terminal.type).toBe('agent-run-finished');
      const successor = await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(terminal) + 1,
      });
      expect(successor.type).toBe('agent-run-finished');
      expect(successor.turnId).not.toBe(first.turnId);
      const requests = model.requests();
      expect(requests).toHaveLength(2);
      expect(requests[1]?.userTexts.join('\n')).toContain(queuedPrompt);
      expect(requests[1]?.body.contents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([expect.objectContaining({ inlineData: { mimeType: 'image/png', data: png } })]),
        }),
      ]));
      const { messages } = await fixture.client.getMessages(chatId);
      expect(userContents(messages)).toEqual([firstPrompt, queuedPrompt]);
      expect(assistantContents(messages)).toEqual(['First reply', 'Image reply']);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('reports a nonzero command as a tool error, not a failed turn', async () => {
    const { model } = requireEnvironment();
    const output = 'synthetic-command-output';
    const reply = 'Synthetic recovery reply';
    model.scriptTurn([geminiFunctionCall('nonzero-command', 'run_command', {
      CommandLine: `printf %s ${output}; exit 9`, toolSummary: 'Report a failing exit code', WaitMsBeforeAsync: 5000,
    })]);
    model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-nonzero-command', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'run the failing command',
        permissionMode: 'bypassPermissions',
      }));
      expect(await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).toMatchObject({ type: 'agent-run-finished', outcome: 'finished' });
      const { messages } = await fixture.client.getMessages(chatId);
      expect(assistantContents(messages)).toEqual([reply]);
      expect(messagesOfType(messages, 'error')).toEqual([]);
      const results = messagesOfType(messages, 'tool-result');
      expect(results.map((result) => result.toolId)).toEqual(['nonzero-command']);
      expect(results[0]?.content.raw).toContain('Command exited with code 9.');
      expect(results[0]?.content.raw).toContain(output);
      expect(results[0]?.isError).toBe(true);
      model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('denies a command with the agent-defined deny option', async () => {
    const testEnvironment = requireEnvironment();
    const command = 'printf %s denied > denied-command.txt && cat denied-command.txt';
    testEnvironment.model.scriptTurn([
      geminiFunctionCall('denied-command', 'run_command', {
        CommandLine: command, toolSummary: 'Write the denied marker', WaitMsBeforeAsync: 5000,
      }),
    ]);

    await withIntegrationFixture('antigravity-scripted-deny', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'try the denied command',
      }));
      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request' && row.message.requestedTool.type === 'bash-tool-use',
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (permission.message.type !== 'permission-request') throw new Error('Expected a command permission request.');
      await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: false,
        alwaysAllow: false,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');

      expect(await Bun.file(join(fixture.executionDirs.project, 'denied-command.txt')).exists()).toBe(false);
      const messages = (await fixture.client.getMessages(chatId)).messages;
      expect(messagesOfType(messages, 'tool-result')).toEqual([
        expect.objectContaining({ toolId: 'denied-command', isError: true }),
      ]);
      expect(messagesOfType(messages, 'permission-resolved')).toEqual([
        expect.objectContaining({ allowed: false }),
      ]);
      expect(testEnvironment.model.requests()).toHaveLength(1);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('writes and edits files without prompting in accept-edits mode', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('EDITS_DONE');
    testEnvironment.model.scriptTurn((request) => [
      geminiFunctionCall('scripted-read', 'read_file', { Path: join(projectPathFrom(request.lastUserText), 'notes.txt') }),
    ]);
    testEnvironment.model.scriptTurn((request) => [
      geminiFunctionCall('scripted-write', 'write_file', {
        Path: join(projectPathFrom(request.userTexts[0] ?? ''), 'created.txt'), Content: 'created\n',
      }),
    ]);
    testEnvironment.model.scriptTurn((request) => [
      geminiFunctionCall('scripted-edit', 'edit_file', {
        Path: join(projectPathFrom(request.userTexts[0] ?? ''), 'notes.txt'), Target: 'alpha', Replacement: 'beta',
      }),
    ]);
    testEnvironment.model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-edits', async (fixture) => {
      const project = fixture.executionDirs.project;
      await writeFile(join(project, 'notes.txt'), 'alpha line\n');
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: project, command: `edit files in PROJECT=${project}=PROJECT`, permissionMode: 'acceptEdits',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });

      expect(await readFile(join(project, 'notes.txt'), 'utf8')).toBe('beta line\n');
      expect(await readFile(join(project, 'created.txt'), 'utf8')).toBe('created\n');
      const messages = (await fixture.client.getMessages(chatId)).messages;
      expect(messagesOfType(messages, 'read-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-read', filePath: join(project, 'notes.txt') }),
      ]);
      expect(messagesOfType(messages, 'write-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-write', filePath: join(project, 'created.txt'), content: 'created\n' }),
      ]);
      expect(messagesOfType(messages, 'edit-tool-use')).toEqual([
        expect.objectContaining({ toolId: 'scripted-edit', oldString: 'alpha', newString: 'beta' }),
      ]);
      expect(messagesOfType(messages, 'unknown-tool-use')).toEqual([]);
      expect(messagesOfType(messages, 'permission-resolved')).toEqual([]);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('stops a running turn and continues the session', async () => {
    const testEnvironment = requireEnvironment();
    const held = testEnvironment.model.scriptHeldTurn([geminiText('never delivered')]);
    const reply = marker('AFTER_STOP');
    const successor = testEnvironment.model.scriptHeldTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-stop', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'start a long turn',
      }));
      const stoppedRequest = await withTimeout(
        held.requested, LIVE_TURN_TIMEOUT_MS, () => 'agy did not dispatch the interruptible turn',
      );
      expect(stoppedRequest.signal.aborted).toBe(false);
      const aborted = once(stoppedRequest.signal, 'abort');
      const launches = join(fixture.executionDirs.home, 'acp-launches');
      const firstLaunch = await readFile(launches, 'utf8');
      expect(firstLaunch).toMatch(/^\d+\n$/);
      const sessionId = await antigravityAgentSessionId(fixture, chatId);

      const stopCursor = fixture.client.markEvents();
      expect((await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() })).outcome)
        .toBe('interrupt-requested');
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS });

      const nextCursor = fixture.client.markEvents();
      const next = await fixture.client.runChat(scriptedAntigravityRunRequest({ chatId, command: 'continue after stop' }));
      await withTimeout(successor.requested, LIVE_TURN_TIMEOUT_MS, () => 'agy did not dispatch the successor turn');
      await withTimeout(aborted, LIVE_TURN_TIMEOUT_MS, () => 'agy did not abort the stopped model request');
      expect(await readFile(launches, 'utf8')).toBe(firstLaunch);
      // Offers the stopped reply while the successor is still active.
      held.release();
      successor.release();
      await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: reply, afterIndex: nextCursor });
      expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toEqual([reply]);
      expect(fixture.client.eventsSince(cursor).some((event) => event.type === 'chat-messages'
        && event.messages.some((entry) => entry.message.type === 'assistant-message'
          && entry.message.content.includes('never delivered')))).toBe(false);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: { ...testEnvironment.serverEnvironment, SCRIPTED_AGY: ANTIGRAVITY_BINARY },
      resolveServerEnvironment: (dirs) => ({ GARCON_ANTIGRAVITY_BINARY: join(dirs.home, 'record-agy') }),
      async prepareWorkspace(dirs) {
        await testEnvironment.prepareWorkspace(dirs);
        // Records launches without interposing on real ACP traffic.
        await writeFile(join(dirs.home, 'record-agy'), [
          '#!/bin/sh',
          'if [ "$1" = acp ]; then echo "$$" >> "$HOME/acp-launches"; fi',
          'exec "$SCRIPTED_AGY" "$@"',
          '',
        ].join('\n'), { mode: 0o700 });
      },
    });
  }, TURN_TIMEOUT_MS);

  test('fails only the rejected model turn and continues the same chat', async () => {
    const testEnvironment = requireEnvironment();
    testEnvironment.model.scriptFault({
      kind: 'http-error', status: 400, message: 'Scripted request rejected.', reason: 'INVALID_ARGUMENT',
    });
    const reply = marker('AFTER_REJECTION');
    testEnvironment.model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-executor-error', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'trigger the model error',
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-failed');

      const messages = (await fixture.client.getMessages(chatId)).messages;
      const errors = messagesOfType(messages, 'error').map((message) => message.content);
      expect(errors).toEqual([expect.stringContaining('Scripted request rejected.')]);
      expect(assistantContents(messages)).toEqual([]);
      const sessionId = await antigravityAgentSessionId(fixture, chatId);
      const nextCursor = fixture.client.markEvents();
      const next = await fixture.client.runChat(scriptedAntigravityRunRequest({ chatId, command: 'try again' }));
      await waitForVisibleResponse({ fixture, chatId, turnId: next.turnId, marker: reply, afterIndex: nextCursor });
      expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
      const recovered = (await fixture.client.getMessages(chatId)).messages;
      expect(assistantContents(recovered)).toEqual([reply]);
      expect(messagesOfType(recovered, 'error').map((message) => message.content)).toEqual(errors);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('resumes the native session after a server restart', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('RESTART_FIRST_PROMPT');
    const firstReply = marker('RESTART_FIRST_REPLY');
    const secondReply = marker('RESTART_SECOND_REPLY');
    testEnvironment.model.scriptTurn([geminiText(firstReply)]);
    testEnvironment.model.scriptTurn((request) => {
      expect(request.userTexts.some((text) => text.includes(firstPrompt))).toBe(true);
      return [geminiText(secondReply)];
    });

    await withIntegrationFixture('antigravity-scripted-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: firstPrompt,
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, marker: firstReply, afterIndex: firstCursor });
      const sessionId = await antigravityAgentSessionId(fixture, chatId);
      const nativeDb = join('.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`);
      expect(await Bun.file(join(fixture.executionDirs.home, nativeDb)).exists()).toBe(true);
      if (fixture.executionDirs.home !== fixture.dirs.home) {
        expect(await Bun.file(join(fixture.dirs.home, nativeDb)).exists()).toBe(false);
      }

      await fixture.restartGarcon();

      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(scriptedAntigravityRunRequest({ chatId, command: 'after restart' }));
      await waitForVisibleResponse({ fixture, chatId, turnId: second.turnId, marker: secondReply, afterIndex: secondCursor });
      expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toEqual([firstReply, secondReply]);
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  // agy ignores the cwd passed to session/resume and keeps the directory
  // recorded with the conversation, so Garcon refuses to move the chat.
  test('refuses a project path update, which agy would not apply', async () => {
    const testEnvironment = requireEnvironment();
    const reply = marker('PATH_REPLY');
    testEnvironment.model.scriptTurn([geminiText(reply)]);

    await withIntegrationFixture('antigravity-scripted-project-path', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedAntigravityStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'establish the session',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, marker: reply, afterIndex: cursor });

      const refused = await fixture.client.updateProjectPath({
        chatId, projectPath: fixture.executionDirs.workspace,
      }).then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(GarconApiError);
      expect(refused).toMatchObject({ status: 422, body: { errorCode: 'PROJECT_PATH_UPDATE_UNSUPPORTED' } });
      expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId))
        .toMatchObject({ projectPath: fixture.executionDirs.project });
      testEnvironment.model.assertSettled();
    }, withScriptedAntigravity());
  }, TURN_TIMEOUT_MS);

  test('generates a title on the selected executor without allowing a command or changing the chat transcript', async () => {
    const generationModel = requireEnvironment().model;
    const localModel = FakeGeminiModel.start();
    const reply = marker('CHAT_REPLY');
    const title = marker('GENERATED_TITLE');

    try {
      await withIntegrationFixture('antigravity-scripted-title', async (fixture) => {
        // In the remote lanes the chat stays Local and only its title runs on the worker.
        const chatModel = fixture.client.executorId === 'local' ? generationModel : localModel;
        chatModel.scriptTurn([geminiText(reply)]);
        const deniedPath = join(fixture.executionDirs.project, 'unexpected-title-command');
        generationModel.scriptTurn([
          geminiText(title),
          geminiFunctionCall('title-command', 'run_command', {
            CommandLine: `touch "${deniedPath}"`, toolSummary: 'Touch the marker', WaitMsBeforeAsync: 5000,
          }),
        ]);
        await fixture.client.updateSettings({ ui: { chatTitle: {
          executorId: fixture.client.executorId, enabled: false, agentId: 'antigravity', model: 'default',
          apiProviderId: null, modelEndpointId: null, modelProtocol: null, thinkingMode: 'none',
        } } });
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat({ ...scriptedAntigravityStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'Discuss the sample project.',
        }), executorId: 'local' });
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor });
        const sessionId = await antigravityAgentSessionId(fixture, chatId);
        const before = (await fixture.client.getMessages(chatId)).messages;

        const generated = await fixture.client.generateChatTitle({ chatId, message: 'Discuss the sample project.' });
        expect(generated.success).toBe(true);
        expect((await fixture.client.listChats()).sessions.find((chat) => chat.id === chatId)?.title).toContain(title);
        expect(await Bun.file(deniedPath).exists()).toBe(false);
        expect((await fixture.client.getMessages(chatId)).messages).toEqual(before);
        expect(await antigravityAgentSessionId(fixture, chatId)).toBe(sessionId);
        generationModel.assertSettled();
        localModel.assertSettled();
      }, {
        ...withScriptedAntigravity(),
        prepareControllerWorkspace: requireEnvironment().prepareWorkspace,
        serverEnvironment: { ...requireEnvironment().serverEnvironment, GOOGLE_GEMINI_BASE_URL: localModel.baseUrl },
        executorEnvironment: { GOOGLE_GEMINI_BASE_URL: generationModel.baseUrl },
      });
    } finally {
      localModel.stop();
    }
  }, TURN_TIMEOUT_MS);
});

// The edit test passes the execution project path through the prompt, since the
// fake model only sees what agy sends it.
function projectPathFrom(text: string): string {
  const match = text.match(/PROJECT=(.+?)=PROJECT/);
  if (!match) throw new Error('The prompt did not carry the project path.');
  return match[1]!;
}
