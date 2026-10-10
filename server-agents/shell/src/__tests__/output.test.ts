import { expect, it } from 'bun:test';
import { CommandOutputMessage } from '@garcon/common/chat-types';
import { COMMAND_OUTPUT_BYTES, CommandOutputTail } from '../output.js';

const message = (channel: 'stdout' | 'stderr', content: string, offset = 0) => new CommandOutputMessage(
  '2026-01-01T00:00:00.000Z', 'command-1', channel, 'plain', content,
  { executorId: 'local', projectPath: '/workspace' }, offset,
);

it('bounds both streams together and groups the retained tail without changing offsets', () => {
  const tail = new CommandOutputTail();
  tail.append(message('stdout', 'x'.repeat(COMMAND_OUTPUT_BYTES)));
  tail.append(message('stderr', 'diagnostic'));
  tail.append(message('stdout', 'end', COMMAND_OUTPUT_BYTES));
  expect(tail.truncated).toBe(true);
  expect(tail.messages().map(row => row.channel)).toEqual(['stdout', 'stderr']);
  expect(tail.messages()[0]!.offset).toBe(13);
  expect(tail.messages().reduce((size, row) => size + Buffer.byteLength(row.content), 0)).toBe(COMMAND_OUTPUT_BYTES);
});

it('never splits a UTF-8 code point at the retained boundary', () => {
  const tail = new CommandOutputTail();
  tail.append(message('stdout', '\u20ac'.repeat(COMMAND_OUTPUT_BYTES)));
  expect(tail.truncated).toBe(true);
  const [row] = tail.messages();
  expect(row!.content).toBe('\u20ac'.repeat(Math.floor(COMMAND_OUTPUT_BYTES / 3)));
  expect(row!.offset + row!.content.length).toBe(COMMAND_OUTPUT_BYTES);
});

it('preserves complete output below the bound', () => {
  const tail = new CommandOutputTail();
  const row = message('stdout', 'small');
  tail.append(row);
  expect(tail.messages()).toEqual([row]);
  expect(tail.truncated).toBe(false);
});

it('stores truncated Markdown stdout as literal output for every transcript consumer', () => {
  const tail = new CommandOutputTail();
  const row = message('stdout', 'x'.repeat(COMMAND_OUTPUT_BYTES) + '\n# retained tail');
  tail.append(new CommandOutputMessage(row.timestamp, row.commandId, row.channel, 'markdown', row.content, row.context));
  expect(tail.messages()[0]).toMatchObject({ format: 'plain', offset: expect.any(Number) });
  expect(tail.messages()[0]!.content.endsWith('# retained tail')).toBe(true);
});
