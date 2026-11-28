#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const modelId = 'gemini-test-low';
const availableModels = [
  { modelId, name: 'Gemini Test (Low)' },
  { modelId: 'gemini-test-high', name: 'Gemini Test (High)' },
];
let currentModelId = modelId;
const mode = {
  id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
  options: [{ value: 'default' }, { value: 'accept-edits' }, { value: 'plan' }],
};
const sessionId = 'session-1';
const options = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];
const refusal = "Can't add this prompt to session: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again";
const send = (...frames: object[]) => process.stdout.write(
  frames.map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n').join(''),
);
const reply = (id: number | string, result: unknown) => ({ id, result });
const end = (id: number | string, stopReason = 'end_turn') => reply(id, { stopReason });
const update = (sessionUpdate: string, fields: object) => ({
  method: 'session/update', params: { sessionId, update: { sessionUpdate, ...fields } },
});
const text = (text: string) => update('agent_message_chunk', { content: { type: 'text', text } });

let pending: number | null = null;
let permission = false;
const setting = process.env.GARCON_TEST_AGY_SETTING;
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  const { id, method, params, result } = frame;
  appendFileSync(`${import.meta.dir}/received.jsonl`, line + '\n');
  switch (method) {
    case 'initialize':
      send(reply(id, {
        protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        authMethods: [{ id: process.env.GEMINI_API_KEY ? 'gemini-api-key' : 'oauth-personal' }],
      }));
      break;
    case 'authenticate':
      send(reply(id, {}));
      break;
    case 'session/new':
      send(reply(id, { sessionId, models: { currentModelId, availableModels }, configOptions: [mode] }));
      break;
    case 'session/resume':
      send(reply(id, { models: { currentModelId, availableModels } }));
      break;
    case 'session/set_model':
      currentModelId = params.modelId;
      send(reply(id, {}));
      break;
    case 'session/set_config_option':
      send(reply(id, setting === 'unconfirmed'
        ? { configOptions: [] }
        : { configOptions: [{ ...mode, currentValue: setting === 'wrong-mode' ? 'default' : params.value }] }));
      break;
    case 'session/prompt': {
      const input = params.prompt[0]?.text;
      if (pending !== null) {
        if (permission) send({ id, error: { code: -32603, message: refusal } });
        else {
          send(end(pending));
          pending = null;
          send(text(input), reply(id, { stopReason: 'end_turn', usage: { totalTokens: 4 } }));
        }
      } else if (input === 'hold') {
        pending = id;
        send(text('First. '));
      } else if (input === 'permission') {
        pending = id;
        permission = true;
        send({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
          sessionId, options,
          toolCall: { toolCallId: 'tool-1', name: 'run_command', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'echo synthetic' } },
        } });
      } else if (input === 'upstream-error') {
        send(text('Partial.\n\u26a0 agent executor error: Error 429\n'), text(''), end(id), text('After the reply.'));
      } else if (input === 'quoted-error') {
        send(text('Quote:\n\u26a0 agent executor error: quoted\n'),
          update('tool_call_update', { toolCallId: 'tool-9', status: 'in_progress' }), end(id));
      } else {
        send(text(input ?? 'Image received.'), end(id));
      }
      break;
    }
    case 'session/cancel':
      if (pending !== null && setting !== 'ignore-cancel') {
        send(text('Stopped.'), end(pending, 'cancelled'));
        pending = null;
      }
      break;
    default:
      if (id === 'permission-1' && pending !== null) {
        send(text(result.outcome.optionId === 'deny' ? 'Denied.' : 'Allowed.'), end(pending));
        pending = null;
        permission = false;
      }
  }
}
