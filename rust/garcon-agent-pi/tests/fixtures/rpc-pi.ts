#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

await appendFile('fake-pi-starts', 'spawn\n');
const responses = {
  sessionId: 'synthetic-session',
  sessionFile: join(process.cwd(), 'synthetic-session.jsonl'),
  steeringMode: 'all',
  thinkingLevel: 'off',
  model: { provider: 'synthetic', id: 'model', reasoning: false },
};
const send = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  const reply = (data?: object) => send({
    id: command.id, type: 'response', command: command.type, success: true, data,
  });
  switch (command.type) {
    case 'set_steering_mode':
      if (command.mode !== 'all') throw new Error('Unexpected steering mode');
      reply();
      break;
    case 'get_state':
      reply(responses);
      break;
    case 'prompt':
      reply({ disposition: 'started' });
      send({ type: 'agent_start' });
      if (command.message === 'held') break;
      send({
        type: 'message_end',
        message: {
          role: 'assistant', stopReason: 'stop',
          content: 'Reply: ' + command.message, timestamp: '2000-01-01T00:00:00.000Z',
        },
      });
      send({ type: 'agent_settled' });
      break;
    case 'steer':
      if (command.message !== 'course correction') throw new Error('Unexpected steering text');
      reply({ disposition: 'queued' });
      send({ type: 'queue_update', steering: [command.message], followUp: [] });
      break;
    default:
      throw new Error('Unexpected command: ' + command.type);
  }
}
