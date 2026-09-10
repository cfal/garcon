import { describe, expect, test } from 'bun:test';
import { claudeText, claudeToolUse, FakeClaudeModel } from '../../support/fake-claude-model.js';

describe('FakeClaudeModel protocol and failure isolation', () => {
  for (const { body, issue } of [
    { body: '{', issue: 'Messages request body was not valid JSON' },
    { body: '[]', issue: 'Messages request body was not an object' },
  ]) {
    test(`rejects an invalid body without consuming a script: ${issue}`, async () => {
      const model = FakeClaudeModel.start();
      try {
        model.scriptTurn([claudeText('Synthetic successor reply')]);
        const response = await fetch(`${model.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toEqual({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'invalid request body' },
        });
        expect(model.issues()).toEqual([issue]);
        expect(model.requests()).toEqual([]);
        const successor = await request(model, false);
        expect(successor.status).toBe(200);
        expect(await successor.json()).toMatchObject({
          content: [{ type: 'text', text: 'Synthetic successor reply' }],
        });
        expect(model.requests()).toHaveLength(1);
        expect(() => model.assertSettled()).toThrow(new RegExp(`^Fake Claude model was not settled:\\n${issue}$`));
      } finally {
        model.stop();
      }
    });
  }

  for (const stream of [true, false]) {
    test(`rejects an unscripted request with JSON 400 (stream=${stream})`, async () => {
      const model = FakeClaudeModel.start();
      try {
        const response = await request(model, stream);
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toMatchObject({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'no scripted turn available' },
        });
        expect(() => model.assertSettled()).toThrow('no scripted turn');
      } finally {
        model.stop();
      }
    });
  }

  for (const asynchronous of [false, true]) {
    test(`contains a callback failure and preserves the next script (async=${asynchronous})`, async () => {
      const model = FakeClaudeModel.start();
      const failure = new Error('Synthetic scripted callback failure');
      try {
        model.scriptTurn(asynchronous
          ? async () => { throw failure; }
          : () => { throw failure; });
        model.scriptTurn([claudeText('Synthetic successor reply')]);

        const failed = await request(model, true);
        expect(failed.status).toBe(400);
        expect(await failed.json()).toMatchObject({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'scripted turn failed' },
        });
        const successor = await request(model, true);
        expect(successor.status).toBe(200);
        expect(await successor.text()).toContain('Synthetic successor reply');
        expect(model.requests()).toHaveLength(2);
        expect(model.issues()).toEqual(['Request 1 scripted turn failed: Synthetic scripted callback failure']);
        expect(() => model.assertSettled()).toThrow(failure.message);
      } finally {
        model.stop();
      }
    });
  }

  test('returns complete JSON messages for non-streaming text and tool turns', async () => {
    const model = FakeClaudeModel.start();
    try {
      model.scriptTurn([claudeText('Synthetic text reply')]);
      model.scriptTurn([
        claudeText('Synthetic tool introduction'),
        claudeToolUse('toolu_synthetic', 'Bash', { command: 'printf synthetic' }),
      ]);
      const text = await request(model, false);
      expect(text.headers.get('content-type')).toContain('application/json');
      expect(await text.json()).toEqual({
        id: 'msg_scripted_1',
        type: 'message',
        role: 'assistant',
        model: 'scripted-model',
        content: [{ type: 'text', text: 'Synthetic text reply' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 },
      });
      const tool = await request(model, false);
      expect(tool.status).toBe(200);
      expect(await tool.json()).toMatchObject({
        id: 'msg_scripted_2',
        content: [
          { type: 'text', text: 'Synthetic tool introduction' },
          { type: 'tool_use', id: 'toolu_synthetic', name: 'Bash', input: { command: 'printf synthetic' } },
        ],
        stop_reason: 'tool_use',
      });
      model.assertSettled();
    } finally {
      model.stop();
    }
  });

  test('keeps explicitly scripted HTTP, stream-error, and truncated-stream faults', async () => {
    const model = FakeClaudeModel.start();
    try {
      model.scriptFault({ kind: 'http-error', status: 503, message: 'Synthetic unavailable' });
      model.scriptFault({ kind: 'stream-error', message: 'Synthetic stream failure' });
      model.scriptFault({ kind: 'truncated-stream' });

      const unavailable = await request(model, false);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ error: { message: 'Synthetic unavailable' } });
      const streamFailure = await request(model, true);
      expect(await streamFailure.text()).toContain('Synthetic stream failure');
      const truncated = await request(model, true);
      const events = await truncated.text();
      expect(events).toContain('event: message_start');
      expect(events).not.toContain('event: message_stop');
      model.assertSettled();
    } finally {
      model.stop();
    }
  });

  test('rejects a stream-only fault on a non-streaming request', async () => {
    const model = FakeClaudeModel.start();
    try {
      model.scriptFault({ kind: 'stream-error', message: 'Synthetic stream failure' });
      const response = await request(model, false);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: 'scripted stream fault requires stream: true' } });
      expect(() => model.assertSettled()).toThrow('non-streaming response for a stream fault');
    } finally {
      model.stop();
    }
  });
});

function request(model: FakeClaudeModel, stream: boolean): Promise<Response> {
  return fetch(`${model.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'scripted-model', stream, messages: [{ role: 'user', content: 'Synthetic prompt' }] }),
  });
}
