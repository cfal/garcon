import { expect, test } from 'bun:test';
import { MalformedStoredJsonError, parseStoredJson } from '../stored-json.js';

test('parses stored JSON', () => {
  expect(parseStoredJson('{"synthetic":true}', 'synthetic.json')).toEqual({ synthetic: true });
});

test('names stored JSON that fails to parse without echoing it', () => {
  let failure: unknown;
  try { parseStoredJson('{"secret": SYNTHETIC_SENTINEL}', 'synthetic.json'); } catch (error) { failure = error; }

  expect(failure).toBeInstanceOf(MalformedStoredJsonError);
  expect(failure).toMatchObject({ subject: 'synthetic.json', message: 'synthetic.json is not valid JSON' });
  expect(String((failure as Error).stack)).not.toContain('SYNTHETIC_SENTINEL');
});
