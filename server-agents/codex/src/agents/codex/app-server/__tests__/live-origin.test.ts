import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { CodexAppServerClient } from '../client.js';
import { CodexAppServerRuntime } from '../runtime.js';
import type { CodexThread, CodexTurn, ThreadStartResponse, TurnStartResponse } from '../protocol.js';

function turn(id: string, status: CodexTurn['status'] = 'inProgress'): CodexTurn {
  return { id, status, error: null, items: [], itemsView: 'full', startedAt: null, completedAt: null, durationMs: null };
}

class TestAppServer extends CodexAppServerClient {
  override async connect() {
    return { userAgent: 'test', codexHome: '/project', platformFamily: 'unix', platformOs: 'linux' };
  }

  override async startThread(): Promise<ThreadStartResponse> {
    const thread: CodexThread = {
      id: 'thread', cwd: '/project', forkedFromId: null, preview: '', ephemeral: false, modelProvider: 'test',
      createdAt: 0, updatedAt: 0, status: { type: 'idle' }, path: fileURLToPath(import.meta.url), cliVersion: '0.169.0', source: null,
      agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [],
    };
    return { thread, model: 'gpt-5.4-codex', modelProvider: 'test', serviceTier: null, cwd: thread.cwd };
  }

  override async startTurn(): Promise<TurnStartResponse> {
    this.emit('notification', { method: 'turn/started', params: { threadId: 'thread', turn: turn('unrelated') } });
    this.text('unrelated', 'unrelated output before receipt');
    this.end('unrelated');
    this.emit('notification', { method: 'turn/started', params: { threadId: 'thread', turn: turn('submitted') } });
    this.text('submitted', 'matched output before receipt');
    this.text('submitted', 'background async message', 'async');
    return { turn: turn('submitted') };
  }

  text(turnId: string, text: string, delivery?: 'async') {
    this.emit('notification', { method: 'item/completed', params: { threadId: 'thread', turnId,
      item: { type: 'agentMessage', id: text, text, phase: 'commentary', memoryCitation: null, delivery } } });
  }

  end(turnId: string) {
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: turn(turnId, 'completed') } });
  }
}

test('fresh Codex provenance follows the turn named by the request reply, not the first notification', async () => {
  const client = new TestAppServer();
  const runtime = new CodexAppServerRuntime({ createClient: () => client });
  const events: AgentRuntimeEvent[] = [];
  const ended = Promise.withResolvers<void>();
  try {
    await runtime.startSession({
      chatId: 'chat', command: 'Synthetic prompt', projectPath: '/project',
      model: 'gpt-5.4-codex', modelEndpointId: null, permissionMode: 'default', thinkingMode: 'low',
      captureLiveOrigin: true,
      operation: { chatId: 'chat', runId: 'managed', publish(event) {
        events.push(event);
        if (event.type === 'run-ended') ended.resolve();
      } },
    });
    expect(events.some(event => event.type === 'run-ended')).toBe(false);
    client.end('submitted');
    await ended.promise;
    client.text('submitted', 'late output');
    expect(events.flatMap(event => event.type === 'rows' ? event.rows.flatMap(row => row.message.type === 'assistant-message'
      ? [[row.message.content, event.originRunId]] : []) : []))
      .toEqual([['matched output before receipt', 'managed'], ['background async message', undefined], ['late output', undefined]]);
  } finally { await runtime.shutdown(); }
});
