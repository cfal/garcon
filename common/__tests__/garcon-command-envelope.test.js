import { expect, test } from 'bun:test';
import { garconEnvelopeSpanAt } from '../garcon-command-envelope.ts';

test('envelope recovery stays within the supplied parse boundary', () => {
  const opener = '<garcon-start-agent>';
  const content = `${opener}<garcon-schedule />body</garcon-start-agent>`;
  for (const end of [opener.length - 1, content.length - 1]) {
    expect(garconEnvelopeSpanAt(content, 0, end)?.end).toBeNull();
  }
  expect(garconEnvelopeSpanAt(content, 0, content.length)?.end).toBe(content.length);
});

test('deeply nested envelopes are scanned without recursive calls', () => {
  const content = '<garcon-start-agent>'.repeat(10_000) + '</garcon-start-agent>'.repeat(10_000);
  expect(garconEnvelopeSpanAt(content, 0, content.length)?.end).toBe(content.length);
  expect(garconEnvelopeSpanAt(content, 0, content.length - 1)?.end).toBeNull();
});

test('quoted delimiters and escaped tag text cannot change the outer span', () => {
  const content = '<garcon-schedule ignored="a > b">&lt;garcon-schedule&gt;</garcon-schedule>';
  expect(garconEnvelopeSpanAt(content, 0, content.length)?.end).toBe(content.length);
});
