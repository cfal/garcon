import { createInterface } from 'node:readline';

const sessionId = 'native-1';
const sessionReply = process.argv[2] === undefined
  ? { sessionId, models: { currentModelId: 'native-default' } }
  : JSON.parse(process.argv[2]);
let pending: number | null = null;
let prompts = 0;
const send = (...frames: object[]) => process.stdout.write(
  frames.map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n').join(''),
);
const text = (content: string, id = sessionId) => ({
  method: 'session/update',
  params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content } },
});
const result = (id: number, stopReason = 'end_turn') => ({ id, result: { stopReason } });

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result: reply } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      break;
    case 'session/new':
    case 'session/load':
      send({ id, result: sessionReply });
      break;
    case 'session/prompt': {
      prompts += 1;
      const input = params.prompt[0].text;
      if (input === 'permission') {
        pending = id;
        send(text('wrong session', 'other'), text('before '), {
          id: 'permission-request',
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'tool-1', title: 'Synthetic permission', kind: 'execute' },
            options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
          },
        });
      } else if (input === 'hold') {
        pending = id;
        send(text('first output'));
      } else {
        send(text(input + ':' + prompts), result(id));
      }
      break;
    }
    case 'session/cancel':
      if (pending !== null) {
        send(result(pending, 'cancelled'));
        pending = null;
      }
      break;
    default:
      if (id === 'permission-request' && pending !== null) {
        send(text('permission ' + reply.outcome.optionId), result(pending));
        pending = null;
      }
  }
}
