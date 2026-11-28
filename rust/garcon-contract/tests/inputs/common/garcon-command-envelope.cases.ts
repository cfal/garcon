import { expect, test } from 'bun:test';
import { GarconEnvelopeScanner, garconEnvelopeSpanAt } from '../../../../../common/garcon-command-envelope.ts';

test('records envelope boundaries under shielding, fences, and truncation', () => {
  const first = '<garcon-start-agent>First.</garcon-start-agent>';
  const second = '<garcon-resume-agent>Second.</garcon-resume-agent>';
  const source = `${first}\n${second}\n</garcon-start-agent>`;
  const scanner = new GarconEnvelopeScanner(source);
  expect(scanner.spanAt(0, first.length)?.end).toBe(first.length);
  expect(scanner.spanAt(0, source.length)?.end).toBeNull();
  expect(scanner.spanAt(first.length + 1, source.length)?.end).toBe(first.length + 1 + second.length);
  for (const [middle, complete] of [
    [second, true],
    [`<!--</garcon-start-agent>${second}-->`, true],
    [`<![CDATA[</garcon-start-agent>${second}]]>`, true],
    [`<?example </garcon-start-agent>${second}?>`, true],
    ['<garcon-schedule ref="a > b" />', true],
    ['<garcon-schedule ref="a < b" />', false],
    ['</garcon-resume-agent>', false],
  ] as const) {
    const content = `<garcon-start-agent>${middle}</garcon-start-agent>`;
    expect(garconEnvelopeSpanAt(content, 0, content.length)?.end).toBe(complete ? content.length : null);
    expect(garconEnvelopeSpanAt(content, 0, content.length - 1)?.end).toBeNull();
  }
  for (const [close, complete] of [['```\r\r', false], ['```xml', false], ['```', true], ['```\r', true], ['``` \r', true]] as const) {
    const content = [first, '```xml', first, close].join('\n');
    expect(garconEnvelopeSpanAt(content, 0, content.length)?.end).toBe(complete ? first.length : null);
  }
  // The original 10,000-level test passes without interception. Recording
  // each inner helper call duplicates the full source, so replay a smaller
  // shape and keep the original depth in the Rust stress test.
  const nested = '<garcon-start-agent>'.repeat(12) + '</garcon-start-agent>'.repeat(12);
  expect(garconEnvelopeSpanAt(nested, 0, nested.length)?.end).toBe(nested.length);
  expect(garconEnvelopeSpanAt(nested, 0, nested.length - 1)?.end).toBeNull();
});
