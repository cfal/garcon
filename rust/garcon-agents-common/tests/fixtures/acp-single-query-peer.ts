import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, capture] = process.argv.slice(2);
if (!mode || !capture) throw new Error('expected mode and capture path');

function send(frame: object) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

function update(fields: object) {
  return { jsonrpc: '2.0', method: 'session/update', params: { update: fields } };
}

let promptId: number | null = null;
const requests = new Set(['permission-1', 'supported-1', 'unsupported-1']);
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(capture, line + '\n');
  const { method, id } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { protocolVersion: 1 } });
  if (method === 'session/new') send({ id, result: { sessionId: 'query-session' } });
  if (method === 'session/set_model') send({ id, result: {} });
  if (method === 'session/prompt' && mode !== 'timeout') {
    promptId = id;
    send(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  hello' } }));
    send(update({ sessionUpdate: 'tool_call', toolCallId: 'first-tool' }));
    send(update({ sessionUpdate: 'agent_message_chunk', content: '\nFAIL: model unavailable' }));
    send(update({ sessionUpdate: 'tool_call_update', toolCallId: 'first-tool', status: 'completed' }));
    if (mode === 'quoted') {
      send(update({ sessionUpdate: 'tool_call_update', toolCallId: 'other-tool' }));
      send(update({ sessionUpdate: 'agent_message', content: [{ type: 'text', text: ' world  ' }] }));
    }
    send({
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        options: [
          { optionId: 'yes', kind: 'allow_once' },
          { optionId: 'never', kind: 'reject_always' },
          { optionId: 'no', kind: 'reject_once' },
        ],
      },
    });
    send({ id: 'supported-1', method: 'sample/version' });
    send({ id: 'unsupported-1', method: 'sample/missing' });
  }
  if (requests.delete(id) && requests.size === 0 && promptId !== null) {
    const late = update({ sessionUpdate: 'agent_message_chunk', content: 'must be ignored' });
    process.stdout.write(
      JSON.stringify({ id: promptId, result: { stopReason: 'end_turn' } }) + '\n'
      + JSON.stringify(late) + '\n',
    );
  }
}
