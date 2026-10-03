import { expect, test } from 'bun:test';
import { GarconEnvelopeScanner, garconEnvelopeSpanAt } from '../garcon-command-envelope.ts';

test('suffix memoization is scoped to its message, command family and parse boundary', () => {
  const first = '<garcon-start-agent ref="first">First.</garcon-start-agent>';
  const second = '<garcon-resume-agent ref="second" chat-id="1111111111111111">Second.</garcon-resume-agent>';
  const content = `${first}\n${second}\n</garcon-start-agent>`;
  const scanner = new GarconEnvelopeScanner(content);
  expect(scanner.spanAt(0, first.length).end).toBe(first.length);
  expect(scanner.spanAt(0, content.length).end).toBeNull();
  expect(scanner.spanAt(first.length + 1, content.length).end).toBe(first.length + 1 + second.length);
  expect(scanner.spanAt(0, first.length + 1 + second.length).end).toBe(first.length);
  expect(new GarconEnvelopeScanner(first).spanAt(0, first.length).end).toBe(first.length);
});

test('suffix memoization is independent of span lookup order after sheltered closers', () => {
  for (const family of ['start-agent', 'resume-agent']) {
    const other = family === 'start-agent' ? 'resume-agent' : 'start-agent';
    const command = `<garcon-${family}>Synthetic.</garcon-${family}>`;
    for (const shelter of [command, `\`\`\`xml\n${command}\n\`\`\``]) {
      const content = `${command}\n${shelter}\n<garcon-${other}\n`;
      const scanner = new GarconEnvelopeScanner(content);
      const first = scanner.spanAt(0, content.length);
      scanner.spanAt(command.length + 1, content.length);
      expect(first.end).toBe(command.length);
      expect(scanner.spanAt(0, content.length)).toEqual(first);
      const reverse = new GarconEnvelopeScanner(content);
      reverse.spanAt(command.length + 1, content.length);
      expect(reverse.spanAt(0, content.length)).toEqual(first);
    }
  }
});

test('suffix and message scans require the same complete fence delimiter', () => {
  const command = '<garcon-start-agent ref="task">Synthetic.</garcon-start-agent>';
  for (const close of ['```\r\r', '```example']) {
    const content = `${command}\n\`\`\`xml\n${command}\n${close}`;
    expect(garconEnvelopeSpanAt(content, 0, content.length).end).toBeNull();
  }
  for (const close of ['```', '```\r', '``` \r']) {
    const content = `${command}\n\`\`\`xml\n${command}\n${close}`;
    expect(garconEnvelopeSpanAt(content, 0, content.length).end).toBe(command.length);
  }
});

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

for (const [open, close] of [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?example', '?>']]) {
  test(`${open} contents cannot close or nest the surrounding envelope`, () => {
    const hidden = `${open}</garcon-start-agent><garcon-schedule>${close}`;
    const content = `<garcon-start-agent>${hidden}</garcon-start-agent>`;
    expect(garconEnvelopeSpanAt(content, 0, content.length)?.end).toBe(content.length);
    expect(garconEnvelopeSpanAt(content, 0, content.indexOf(close) + close.length - 1)?.end).toBeNull();
  });
}
