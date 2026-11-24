import { expect, it } from 'bun:test';
import { AcpAgentRuntime } from '@garcon/server-agent-common/acp/agent-runtime';
import type { AcpJsonRpcMessage } from '@garcon/server-agent-common/acp/protocol';
import { AcpTransport, type AcpProcess } from '@garcon/server-agent-common/acp/transport';
import type { AgentRuntimeEvent } from '@garcon/server-agent-common/execution/runtime-events';
import { CursorAcpEventConverter } from '../cursor-acp-event-converter.ts';
import { createCursorAcpPolicy } from '../cursor-acp-policy.ts';

it('honors a downgrade during Cursor load: only an edit offering a one-time grant runs automatically', async () => {
  const sessionId = 'synthetic-session';
  const load = Promise.withResolvers<AcpJsonRpcMessage>();
  const prompt = Promise.withResolvers<AcpJsonRpcMessage>();
  const drained = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number>();
  const configOptions = [['mode', 'agent'], ['model', 'default']].map(([id, value]) => ({
    id, currentValue: value, options: [{ value }],
  }));
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const send = (fields: Omit<AcpJsonRpcMessage, 'jsonrpc'>) =>
    output.enqueue(new TextEncoder().encode(`${JSON.stringify({ ...fields, jsonrpc: '2.0' })}\n`));
  const answers = new Map<string | number, unknown>();
  const child = {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }),
    stdin: { write(data: string | Uint8Array) {
      const frame = JSON.parse(String(data)) as AcpJsonRpcMessage;
      const { id, method } = frame;
      if (id === undefined) return;
      switch (method) {
        case 'initialize': return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        case 'authenticate': return send({ id, result: {} });
        case 'session/load': return load.resolve(frame);
        case 'session/set_config_option': return send({ id, result: { configOptions } });
        case 'session/prompt': return prompt.resolve(frame);
        default:
          if (id === 'barrier') drained.resolve();
          else answers.set(id, frame.result);
      }
    } },
    exited: exited.promise,
    kill: () => exited.resolve(0),
  } satisfies AcpProcess;
  const runtime = new AcpAgentRuntime(createCursorAcpPolicy({ binary: () => 'synthetic', apiKey: () => null }), {
    converter: new CursorAcpEventConverter(),
    createTransport: () => new AcpTransport({ spawn: () => child }),
  });
  const events: AgentRuntimeEvent[] = [];
  const turn = runtime.runTurn({
    chatId: 'synthetic-chat', agentSessionId: sessionId, projectPath: '/work', model: '', command: 'Synthetic prompt',
    permissionMode: 'manualBypass', thinkingMode: 'none', operation: { runId: 'run-1', publish: (event) => events.push(event) },
  });
  try {
    const loading = await load.promise;
    runtime.updateSessionSettings(sessionId, { permissionMode: 'acceptEdits' });
    send({ id: loading.id, result: { configOptions } });
    const active = await prompt.promise;
    const once = { optionId: 'once', kind: 'allow_once' };
    const always = { optionId: 'always', kind: 'allow_always' };
    const ask = (id: string, kind: string, options: typeof once[]) => send({
      id, method: 'session/request_permission',
      params: { sessionId, toolCall: { toolCallId: id, kind, toolName: kind === 'edit' ? 'Edit' : 'Bash' }, options },
    });
    ask('edit-once', 'edit', [always, once]);
    ask('command', 'execute', [once]);
    ask('persistent-edit', 'edit', [always]);
    ask('persistent-command', 'execute', [always]);
    send({ id: 'barrier', method: 'synthetic/barrier' });
    await drained.promise;
    expect([...answers.entries()]).toEqual([
      ['edit-once', { outcome: { outcome: 'selected', optionId: 'once' } }],
      ['persistent-edit', { outcome: { outcome: 'cancelled' } }],
      ['persistent-command', { outcome: { outcome: 'cancelled' } }],
    ]);
    expect(events.flatMap((event) => event.type === 'permission' && event.lifecycle.kind === 'requested'
      ? [event.lifecycle.requestedTool.toolId] : [])).toEqual(['command']);
    send({ id: active.id, result: { stopReason: 'end_turn' } });
    await turn;
  } finally {
    runtime.shutdown();
    await turn.catch(() => {});
  }
});
