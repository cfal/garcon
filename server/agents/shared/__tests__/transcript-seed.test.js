import { describe, it, expect } from 'bun:test';
import {
  renderTranscriptSeed,
  stripTranscriptSeed,
  stripFirstUserSeed,
  SEED_CONTEXT_OPEN,
  SEED_CONTEXT_CLOSE,
} from '../transcript-seed.js';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  BashToolUseMessage,
  ToolResultMessage,
} from '../../../../common/chat-types.js';

const ts = '2026-01-01T00:00:00Z';

describe('renderTranscriptSeed', () => {
  it('wraps rendered messages in context markers with a preamble', () => {
    const seed = renderTranscriptSeed([
      new UserMessage(ts, 'hello there'),
      new AssistantMessage(ts, 'general kenobi'),
    ]);

    expect(seed).toContain(SEED_CONTEXT_OPEN);
    expect(seed).toContain(SEED_CONTEXT_CLOSE);
    expect(seed).toContain('User: hello there');
    expect(seed).toContain('Assistant: general kenobi');
    expect(seed.startsWith('The following is a prior conversation')).toBe(true);
  });

  it('names the source agent when provided', () => {
    const seed = renderTranscriptSeed([new UserMessage(ts, 'hi')], { fromAgentLabel: 'Codex' });
    expect(seed).toContain('prior conversation with Codex');
  });

  it('flattens tool-use into a short summary and drops thinking', () => {
    const seed = renderTranscriptSeed([
      new BashToolUseMessage(ts, 'tool-1', 'ls -la', 'list files'),
      new ThinkingMessage(ts, 'internal reasoning that should not leak'),
      new ToolResultMessage(ts, 'tool-1', { text: 'file-a\nfile-b' }, false),
    ]);

    expect(seed).toContain('Assistant used bash: list files');
    expect(seed).toContain('Tool result: file-a file-b');
    expect(seed).not.toContain('internal reasoning');
  });

  it('returns empty string when nothing is renderable', () => {
    expect(renderTranscriptSeed([new ThinkingMessage(ts, 'only thinking')])).toBe('');
    expect(renderTranscriptSeed([])).toBe('');
  });

  it('caps to the most recent messages and marks truncation', () => {
    const messages = [
      new UserMessage(ts, 'OLDEST_MARKER'),
      new AssistantMessage(ts, 'x'.repeat(120)),
      new UserMessage(ts, 'NEWEST_MARKER'),
    ];
    const seed = renderTranscriptSeed(messages, { maxChars: 60 });

    expect(seed).toContain('[earlier turns truncated]');
    expect(seed).toContain('NEWEST_MARKER');
    expect(seed).not.toContain('OLDEST_MARKER');
  });
});

describe('stripTranscriptSeed', () => {
  it('removes a rendered seed and returns the trailing user text', () => {
    const seed = renderTranscriptSeed([
      new UserMessage(ts, 'prior question'),
      new AssistantMessage(ts, 'prior answer'),
    ]);
    const combined = `${seed}\n\nhello`;
    expect(stripTranscriptSeed(combined)).toBe('hello');
  });

  it('leaves text without a seed unchanged', () => {
    expect(stripTranscriptSeed('just a normal message')).toBe('just a normal message');
  });

  it('does not strip when a seed marker appears after real user content', () => {
    const text = `real user text ${SEED_CONTEXT_OPEN} not a seed ${SEED_CONTEXT_CLOSE}`;
    expect(stripTranscriptSeed(text)).toBe(text);
  });
});

describe('stripFirstUserSeed', () => {
  it('strips the seed only from the first user message', () => {
    const seed = renderTranscriptSeed([new UserMessage(ts, 'prior')]);
    const messages = [
      new AssistantMessage(ts, 'preamble assistant'),
      new UserMessage(ts, `${seed}\n\nreal turn`),
      new UserMessage(ts, `${seed}\n\nlater turn`),
    ];
    const result = stripFirstUserSeed(messages);

    expect(result[1].content).toBe('real turn');
    // Later user messages are untouched; only the seeded first turn is cleaned.
    expect(result[2].content).toBe(`${seed}\n\nlater turn`);
  });

  it('returns the same array when there is no seeded first message', () => {
    const messages = [new UserMessage(ts, 'plain turn')];
    expect(stripFirstUserSeed(messages)).toBe(messages);
  });
});
