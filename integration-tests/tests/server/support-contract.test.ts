import { describe, expect, test } from 'bun:test';
import { BoundedLog } from '../../support/bounded-log.js';
import { Deferred } from '../../support/deferred.js';
import { FakeOpenAiServer } from '../../support/fake-openai-server.js';

describe('integration support contracts', () => {
  test('settles deferred values only once', async () => {
    const deferred = new Deferred<string>();
    expect(deferred.resolve('first')).toBe(true);
    expect(deferred.resolve('second')).toBe(false);
    expect(deferred.reject(new Error('ignored'))).toBe(false);
    expect(await deferred.promise).toBe('first');
  });

  test('retains only the newest bounded log entries', () => {
    const log = new BoundedLog<number>(2);
    log.push(1);
    log.push(2);
    log.push(3);
    expect(log.values()).toEqual([2, 3]);
  });

  test('serves models and deterministic streaming echoes', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const models = await fetch(`${fake.baseUrl}/v1/models`).then((response) => response.json());
      expect(models).toMatchObject({ data: [{ id: 'integration-echo' }] });

      const response = await fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'integration-echo',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('echo:');
      expect(text).toContain('hello');
      expect(text).toContain('data: [DONE]');
      expect(fake.requests()).toHaveLength(1);
      expect(fake.requests()[0].lastUserText).toBe('hello');
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('holds and explicitly releases a matched request', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const held = fake.holdNext({ lastUserText: 'held' });
      const responsePromise = fetch(`${fake.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'integration-echo',
          messages: [{ role: 'user', content: 'held' }],
          stream: true,
        }),
      });
      expect((await held.received).lastUserText).toBe('held');
      held.releaseText('released');
      const body = await (await responsePromise).text();
      const streamed = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content: string } }> })
        .map((event) => event.choices[0].delta.content)
        .join('');
      expect(streamed).toBe('released');
    } finally {
      fake.stop();
    }
  });

  test('records unsupported requests as protocol violations', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      const response = await fetch(`${fake.baseUrl}/unexpected`);
      expect(response.status).toBe(400);
      expect(fake.protocolViolations()).toHaveLength(1);
      expect(() => fake.assertNoProtocolViolations()).toThrow('protocol violations');
    } finally {
      fake.stop();
    }
  });

  test('waits for a matching request strictly after the supplied cursor', async () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    const request = () => fetch(`${fake.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'integration-echo',
        messages: [{ role: 'user', content: 'cursor' }],
        stream: true,
      }),
    }).then((response) => response.text());
    try {
      await request();
      const firstId = fake.requests()[0].id;
      const nextRequest = fake.waitForRequest({ lastUserText: 'cursor' }, { afterId: firstId });
      await request();
      expect((await nextRequest).id).toBeGreaterThan(firstId);
      fake.assertNoProtocolViolations();
    } finally {
      fake.stop();
    }
  });

  test('reports unused response plans during teardown validation', () => {
    const fake = FakeOpenAiServer.start({ defaultDelayMs: 0 });
    try {
      fake.failNextHttp({ lastUserText: 'never-sent' }, 500, 'unused');
      expect(() => fake.assertNoProtocolViolations()).toThrow('Unused fake-provider response plans');
    } finally {
      fake.stop();
    }
  });
});
