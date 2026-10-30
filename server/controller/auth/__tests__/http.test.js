import { expect, mock, spyOn, test } from 'bun:test';
import { AuthValidationError } from '../../../../common/auth.js';
import { readAuthBody } from '../http.js';

const encoder = new TextEncoder();

function request(body, options = {}) {
  return new Request('http://localhost/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, ...options,
  });
}

function chunks(values) {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

test('decodes multibyte UTF-8 split across chunks and accepts JSON media type parameters', async () => {
  const value = { username: 'caf\u00e9-\u2603', password: 'synthetic-password' };
  const bytes = encoder.encode(JSON.stringify(value));
  const input = request(chunks([...bytes].map(byte => Uint8Array.of(byte))), {
    headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
  });
  expect(await readAuthBody(input)).toEqual(value);
  expect(input.body.locked).toBe(false);
});

test('accepts the exact byte limit and counts bytes rather than decoded characters', async () => {
  const overhead = encoder.encode(JSON.stringify({ value: '' })).byteLength;
  const boundary = { value: 'a'.repeat(4096 - overhead) };
  expect(await readAuthBody(request(JSON.stringify(boundary)))).toEqual(boundary);

  const oversized = JSON.stringify({ value: '\u00e9'.repeat(2043) });
  expect(oversized.length).toBeLessThan(4096);
  expect(encoder.encode(oversized).byteLength).toBeGreaterThan(4096);
  const cancel = mock();
  const input = request(new ReadableStream({
    start(controller) {
      const bytes = encoder.encode(oversized);
      controller.enqueue(bytes.slice(0, 2048));
      controller.enqueue(bytes.slice(2048));
    },
    cancel,
  }));
  const error = await readAuthBody(input).catch(error => error);
  expect(error).toMatchObject({ code: 'AUTH_REQUEST_TOO_LARGE', status: 413 });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(input.body.locked).toBe(false);
});

test('rejects an oversized Content-Length without consuming or locking the body', async () => {
  const input = request('{}', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' },
  });
  expect(await readAuthBody(input).catch(error => error))
    .toMatchObject({ code: 'AUTH_REQUEST_TOO_LARGE', status: 413 });
  expect(input.bodyUsed).toBe(false);
  expect(input.body.locked).toBe(false);
});

test.each([
  ['malformed JSON', encoder.encode('{')],
  ['invalid UTF-8 inside otherwise valid JSON', Uint8Array.from([
    ...encoder.encode('{"value":"'), 0xff, ...encoder.encode('"}'),
  ])],
  ['truncated UTF-8 after valid JSON', Uint8Array.from([...encoder.encode('{}'), 0xc3])],
])('rejects %s and releases its reader slot', async (_, bytes) => {
  const input = request(chunks([bytes]));
  expect(await readAuthBody(input).catch(error => error)).toBeInstanceOf(AuthValidationError);
  expect(input.body.locked).toBe(false);
  expect(await readAuthBody(request('{}'))).toEqual({});
});

test.each([
  ['missing body', () => request(undefined)],
  ['non-JSON body', () => request('{}', { headers: { 'Content-Type': 'text/plain' } })],
])('rejects %s before reading', async (_, makeRequest) => {
  const input = makeRequest();
  expect(await readAuthBody(input).catch(error => error)).toBeInstanceOf(AuthValidationError);
  expect(input.bodyUsed).toBe(false);
});

test('bounds concurrent readers and recovers capacity after a caller aborts', async () => {
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const cancel = mock();
  const firstInput = request(new ReadableStream({ cancel }), { signal: firstAbort.signal });
  let secondSource;
  const secondInput = request(new ReadableStream({ start(controller) { secondSource = controller; } }),
    { signal: secondAbort.signal });
  const first = readAuthBody(firstInput).catch(error => error);
  const second = readAuthBody(secondInput).catch(error => error);
  try {
    const blocked = request('{}');
    expect(await readAuthBody(blocked).catch(error => error)).toMatchObject({ code: 'AUTH_BUSY', status: 429 });
    expect(blocked.bodyUsed).toBe(false);
    firstAbort.abort();
    expect(await first).toBeInstanceOf(AuthValidationError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(firstInput.body.locked).toBe(false);
    expect(await readAuthBody(request('{}'))).toEqual({});
    secondSource.enqueue(encoder.encode('{"remaining":true}'));
    secondSource.close();
    expect(await second).toEqual({ remaining: true });
    expect(secondInput.body.locked).toBe(false);
  } finally {
    firstAbort.abort();
    secondAbort.abort();
    await Promise.all([first, second]);
  }
});

test('the read deadline cancels a stalled body and restores capacity', async () => {
  const deadline = new AbortController();
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const cancel = mock();
  const input = request(new ReadableStream({ cancel }));
  const pending = readAuthBody(input).catch(error => error);
  try {
    expect(timeout).toHaveBeenCalledWith(5000);
    deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
    expect(await pending).toBeInstanceOf(AuthValidationError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(input.body.locked).toBe(false);
    expect(input.signal.aborted).toBe(false);
  } finally {
    deadline.abort();
    await pending;
    timeout.mockRestore();
  }
  expect(await readAuthBody(request('{}'))).toEqual({});
});

test('source failures release the reader and do not poison subsequent requests', async () => {
  const failure = new Error('Synthetic source failure');
  const input = request(new ReadableStream({ start(controller) { controller.error(failure); } }));
  expect(await readAuthBody(input).catch(error => error)).toBe(failure);
  expect(input.body.locked).toBe(false);
  expect(await readAuthBody(request('{}'))).toEqual({});
});
