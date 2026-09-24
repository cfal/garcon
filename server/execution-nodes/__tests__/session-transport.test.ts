import { expect, test } from 'bun:test';
import { SessionTransport } from '../session-transport.js';

test('transport becomes ready when the authenticated socket attaches', async () => {
  const failures: Error[] = [];
  const messages: string[] = [];
  const availability: boolean[] = [];
  const transport = new SessionTransport('session', 'worker', error => failures.push(error));
  transport.onMessage(message => messages.push(message));
  transport.onAvailability(connected => availability.push(connected));
  const connection = transport.attach({ send() {}, close() {} });
  await transport.ready;
  connection.receive('message');
  expect(messages).toEqual(['message']);
  connection.disconnected();
  connection.receive('late message');
  expect(availability).toEqual([true, false]);
  expect(messages).toEqual(['message']);
  expect(failures).toHaveLength(1);
});

test('retirement before attachment rejects readiness', async () => {
  const transport = new SessionTransport('session', 'worker', () => {});
  transport.close(new Error('closed before authentication'));
  await expect(transport.ready).rejects.toThrow('closed before authentication');
  expect(() => transport.attach({ send() {}, close() {} })).toThrow('closed before authentication');
});
