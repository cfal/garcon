import { expect, test } from 'bun:test';
import { readJsonResponse } from '../json-response.js';

test('parses a JSON body', async () => {
  await expect(readJsonResponse(Response.json({ synthetic: true }), 'Synthetic source')).resolves.toEqual({ synthetic: true });
});

test('names a body that is not JSON without echoing it', async () => {
  const failure = await readJsonResponse(new Response('{"synthetic": SYNTHETIC_SENTINEL'), 'Synthetic source')
    .catch((error: unknown) => error);

  expect(failure).not.toBeInstanceOf(SyntaxError);
  expect((failure as Error).message).toBe('Synthetic source response is not valid JSON.');
});

test('keeps the error of a body that fails to arrive', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error('Synthetic read failure')); } });

  await expect(readJsonResponse(new Response(body), 'Synthetic source')).rejects.toThrow('Synthetic read failure');
});
