import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { assistantContents, messagesOfType, userContents } from '../../support/chat-assertions.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { LIVE_TURN_TIMEOUT_MS, reloadUntilNativeStableAfterPrompt, waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment, type ScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

describe('scripted Claude Monitor', () => {
  let environment: ScriptedClaudeTestEnvironment;
  beforeEach(async () => { environment = await startScriptedClaudeTestEnvironment(); });
  afterEach(() => environment.dispose());

  test.each(['command', 'socket'] as const)('owns %s events and completion before admitting queued input', async (mode) => {
    const connected = Promise.withResolvers<ServerWebSocket<undefined>>();
    const watchServer = mode === 'socket' ? Bun.serve({
      hostname: '0.0.0.0', port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { headers: { 'Sec-WebSocket-Protocol': 'synthetic-events' } })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: { open(socket) { connected.resolve(socket); }, message() {} },
    }) : null;
    try {
      await withIntegrationFixture(`claude-scripted-monitor-${mode}`, async (fixture) => {
        const eventGate = join(fixture.executionDirs.project, 'synthetic-event-gate');
        const endGate = join(fixture.executionDirs.project, 'synthetic-end-gate');
        const monitorInput = {
          description: 'Synthetic event watch', timeout_ms: 120_000,
          ...(watchServer ? { ws: { url: `ws://127.0.0.1:${watchServer.port}/events`, protocols: ['synthetic-events'] } } : {
            persistent: false, allowed_domains: [],
            command: `while [ ! -f ${eventGate} ]; do sleep 0.05; done; printf 'synthetic-watch-event\n'; `
              + `while [ ! -f ${endGate} ]; do sleep 0.05; done`,
          }),
        };
        scriptDiscovery(environment);
        environment.model.scriptTurn((request) => {
          expect(request.body.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: expect.arrayContaining([
              expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_discover_monitor',
                content: expect.arrayContaining([{ type: 'tool_reference', tool_name: 'Monitor' }]),
              }),
            ]) }),
          ]));
          return [claudeToolUse('toolu_monitor', 'Monitor', monitorInput)];
        });
        environment.model.scriptTurn([claudeText('Synthetic watch armed')]);
        environment.model.scriptTurn((request) => {
          expect(request.lastUserText).toContain('synthetic-watch-event');
          return [claudeText('Synthetic watch event observed')];
        });
        environment.model.scriptTurn((request) => {
          expect(request.lastUserText).toContain('<task-notification>');
          return [claudeText('Synthetic watch ended')];
        });
        environment.model.scriptTurn((request) => {
          expect(request.lastUserText).toContain('Synthetic successor input');
          expect(request.lastUserText).not.toContain('<task-notification>');
          return [claudeText('Synthetic successor reply')];
        });
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveClaudeStartRequest({
          chatId, projectPath: fixture.executionDirs.project, command: 'Synthetic watch input',
          permissionMode: mode === 'socket' ? 'default' : 'bypassPermissions',
        }));
        if (mode === 'socket') {
          const permission = await fixture.client.waitForTransientPermission(chatId,
            (row) => row.message.type === 'permission-request' && row.message.requestedTool.type === 'claude-monitor-tool-use',
            { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS });
          if (permission.message.type !== 'permission-request') throw new Error('Expected a Monitor permission request');
          expect(permission.message.requestedTool).toMatchObject({
            type: 'claude-monitor-tool-use', webSocketUrl: 'ws' in monitorInput ? monitorInput.ws.url : undefined,
            webSocketProtocols: ['synthetic-events'],
          });
          expect((await fixture.client.sendPermissionDecision({
            clientRequestId: crypto.randomUUID(), chatId,
            permissionOccurrenceId: permission.permissionOccurrenceId, allow: true, alwaysAllow: false,
          })).status).toBe('accepted');
        }
        await waitForAssistant(fixture, chatId, 'Synthetic watch armed', cursor);
        const queued = await fixture.client.enqueueNew(chatId, 'Synthetic successor input');
        expect(queued.control.queue.entries.map((entry) => entry.content)).toEqual(['Synthetic successor input']);
        if (watchServer) (await connected.promise).send('synthetic-watch-event');
        else await writeFile(eventGate, 'synthetic');
        await waitForAssistant(fixture, chatId, 'Synthetic watch event observed', cursor);
        expect(fixture.client.eventsSince(cursor)).not.toContainEqual(expect.objectContaining({
          type: 'agent-run-finished', chatId, turnId: turn.turnId,
        }));
        expect((await fixture.client.getExecutionControl(chatId)).queue.entries.map((entry) => entry.content))
          .toEqual(['Synthetic successor input']);
        if (watchServer) (await connected.promise).close();
        else await writeFile(endGate, 'synthetic');
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId,
          marker: 'Synthetic watch ended', afterIndex: cursor });
        const successor = await fixture.client.waitForCommittedUserInput(chatId, 'Synthetic successor input',
          { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS });
        expect((await fixture.client.waitForTurnTerminal(chatId, undefined, {
          afterIndex: fixture.client.events().lastIndexOf(successor) + 1, timeoutMs: LIVE_TURN_TIMEOUT_MS,
        })).type).toBe('agent-run-finished');
        const events = fixture.client.eventsSince(cursor);
        const terminals = events.filter((event) => event.type === 'agent-run-finished'
          && event.chatId === chatId && event.turnId === turn.turnId);
        expect(terminals).toHaveLength(1);
        const finalOutputIndex = events.findIndex((event) => event.type === 'chat-messages'
          && event.chatId === chatId && event.messages.some((entry) =>
            entry.message.type === 'assistant-message' && entry.message.content === 'Synthetic watch ended'));
        expect(events.indexOf(terminals[0]!)).toBeGreaterThan(finalOutputIndex);
        expect(events.indexOf(successor)).toBeGreaterThan(events.indexOf(terminals[0]!));
        const live = await fixture.client.getMessages(chatId);
        expect(assistantContents(live.messages)).toEqual([
          'Synthetic watch armed', 'Synthetic watch event observed', 'Synthetic watch ended', 'Synthetic successor reply',
        ]);
        expect(userContents(live.messages)).toEqual(['Synthetic watch input', 'Synthetic successor input']);
        expect(messagesOfType(live.messages, 'unknown-tool-use')).toEqual([]);
        expect(messagesOfType(live.messages, 'claude-tool-search-tool-use')).toHaveLength(1);
        expect(messagesOfType(live.messages, 'claude-monitor-tool-use')).toHaveLength(1);
        if (mode === 'command') {
          expect(messagesOfType(live.messages, 'claude-monitor-tool-use')[0])
            .toMatchObject({ persistent: false, allowedDomains: [] });
        }
        expect(messagesOfType(live.messages, 'tool-result').find((message) => message.toolId === 'toolu_discover_monitor')?.content)
          .toMatchObject({ items: [{ type: 'tool_reference', tool_name: 'Monitor' }], toolUseResult: { matches: ['Monitor'] } });
        const reloaded = await reloadUntilNativeStableAfterPrompt(fixture, chatId, 'Synthetic successor input');
        expect(assistantContents(reloaded.messages)).toEqual(assistantContents(live.messages));
        expect(userContents(reloaded.messages)).toEqual(userContents(live.messages));
        for (const type of ['claude-tool-search-tool-use', 'claude-monitor-tool-use'] as const) {
          expect(messagesOfType(reloaded.messages, type).map(({ timestamp: _timestamp, ...message }) => message))
            .toEqual(messagesOfType(live.messages, type).map(({ timestamp: _timestamp, ...message }) => message));
        }
        expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
        environment.model.assertSettled();
      }, { serverEnvironment: environment.serverEnvironment });
    } finally {
      watchServer?.stop(true);
    }
  }, 120_000);

  test.each(['failure', 'expiry', 'stop'] as const)('retires a Monitor on %s without contaminating the next input', async (outcome) => {
    await withIntegrationFixture(`claude-scripted-monitor-${outcome}`, async (fixture) => {
      const gate = join(fixture.executionDirs.project, 'synthetic-exit-gate');
      const pidPath = join(fixture.executionDirs.project, 'synthetic-monitor-pid');
      const command = `echo $$ > ${pidPath}; while [ ! -f ${gate} ]; do sleep 0.05; done; exit 7`;
      scriptDiscovery(environment);
      environment.model.scriptTurn([claudeToolUse('toolu_monitor', 'Monitor', {
        description: 'Synthetic bounded watch', timeout_ms: outcome === 'expiry' ? 3_000 : 120_000, command,
      })]);
      environment.model.scriptTurn([claudeText('Synthetic bounded watch armed')]);
      if (outcome !== 'stop') environment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain('<task-notification>');
        expect(request.lastUserText).toContain('<task-id>');
        return [claudeText('Synthetic bounded watch settled')];
      });
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId, projectPath: fixture.executionDirs.project, command: 'Synthetic bounded watch input',
        permissionMode: 'bypassPermissions',
      }));
      await waitForAssistant(fixture, chatId, 'Synthetic bounded watch armed', cursor);
      const pid = await waitForMonitorPid(pidPath);
      if (outcome === 'stop') {
        await fixture.client.stopChat({ clientRequestId: crypto.randomUUID(), chatId });
        await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS });
      } else {
        if (outcome === 'failure') await writeFile(gate, 'synthetic');
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId,
          marker: 'Synthetic bounded watch settled', afterIndex: cursor });
      }
      await waitForProcessExit(pid);
      environment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain('Synthetic fresh input');
        if (outcome === 'stop') {
          // Native resume reports the retired source task once; it must not restart it.
          expect(request.lastUserText).toContain('<status>stopped</status>');
        } else expect(request.lastUserText).not.toContain('<task-notification>');
        return [claudeText('Synthetic fresh reply')];
      });
      const freshCursor = fixture.client.markEvents();
      const fresh = await fixture.client.runChat(liveClaudeRunRequest({
        chatId, command: 'Synthetic fresh input', permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: fresh.turnId,
        marker: 'Synthetic fresh reply', afterIndex: freshCursor });
      expect(messagesOfType((await fixture.client.getMessages(chatId)).messages, 'unknown-tool-use')).toEqual([]);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment });
  }, 120_000);
});

function scriptDiscovery(environment: ScriptedClaudeTestEnvironment): void {
  environment.model.scriptTurn([claudeToolUse('toolu_discover_monitor', 'ToolSearch', { query: 'select:Monitor', max_results: 1 })]);
}

async function waitForMonitorPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, 'utf8')).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error('Synthetic Monitor did not report its process ID.');
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error('Synthetic Monitor process survived settlement or Stop.');
}

function waitForAssistant(fixture: IntegrationFixture, chatId: string, content: string, afterIndex: number): Promise<ChatMessagesMessage> {
  return fixture.client.waitForEvent((event): event is ChatMessagesMessage => event.type === 'chat-messages'
    && event.chatId === chatId && event.messages.some((entry) =>
      entry.message.type === 'assistant-message' && entry.message.content === content),
  'synthetic Monitor response', { afterIndex, timeoutMs: LIVE_TURN_TIMEOUT_MS });
}
