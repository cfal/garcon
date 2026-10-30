import { describe, expect, it } from 'bun:test';
import {
  parseChatTranscriptActivity,
  previewFirstLine,
  summarizeTranscriptActivity,
} from '../chat-transcript-activity.ts';
import {
  AssistantMessage,
  EnterPlanModeToolUseMessage,
  ErrorMessage,
  ExitPlanModeToolUseMessage,
  ThinkingMessage,
  ToolResultMessage,
  TranscriptNoticeMessage,
  UnknownToolUseMessage,
  UserMessage,
} from '../chat-types.ts';

describe('previewFirstLine', () => {
  it('keeps the trimmed text before the first newline', () => {
    expect(previewFirstLine('first\nsecond\nthird')).toBe('first');
    expect(previewFirstLine('single line')).toBe('single line');
    expect(previewFirstLine('  padded  \nmore')).toBe('padded');
    expect(previewFirstLine('')).toBe('');
  });
});

describe('summarizeTranscriptActivity', () => {
  it('previews the first line of the latest user or assistant message', () => {
    const activity = summarizeTranscriptActivity([
      new UserMessage('2024-01-01T00:00:00Z', 'hello'),
      new UnknownToolUseMessage('2024-01-01T00:00:01Z', 't1', 'ls', {}),
      new AssistantMessage('2024-01-01T00:00:02Z', 'first line\nsecond line'),
    ]);

    expect(activity.preview).toEqual({ content: 'first line', timestamp: '2024-01-01T00:00:02Z' });
    expect(activity.lastActivityAt).toBe('2024-01-01T00:00:02Z');
  });

  it('previews nothing when no conversational message exists', () => {
    expect(summarizeTranscriptActivity([
      new UnknownToolUseMessage('2024-01-01T00:00:01Z', 't1', 'ls', {}),
      new ToolResultMessage('2024-01-01T00:00:02Z', 't1', {}, false),
    ]).preview).toBeNull();
    expect(summarizeTranscriptActivity([
      new TranscriptNoticeMessage('2024-01-01T00:00:01Z', 'presentation only'),
      new ErrorMessage('2024-01-01T00:00:02Z', 'first error line\nsecond'),
    ]).preview).toBeNull();
    expect(summarizeTranscriptActivity([]).preview).toBeNull();
  });

  it('keeps the latest conversational preview over newer thinking content', () => {
    const activity = summarizeTranscriptActivity([
      new UserMessage('2024-01-01T00:00:00Z', 'hello'),
      new ThinkingMessage('2024-01-01T00:00:01Z', 'working on it\nstep two'),
    ]);

    expect(activity.preview).toEqual({ content: 'hello', timestamp: '2024-01-01T00:00:00Z' });
  });

  it('bounds the preview to 200 characters', () => {
    const activity = summarizeTranscriptActivity([
      new AssistantMessage('2024-01-01T00:00:00Z', 'a'.repeat(300)),
    ]);

    expect(activity.preview?.content.length).toBe(200);
  });

  it('tracks the latest timestamp independently of preview eligibility', () => {
    const activity = summarizeTranscriptActivity([
      new ThinkingMessage('2024-01-01T00:00:02Z', 'newer activity'),
      new AssistantMessage('2024-01-01T00:00:00Z', 'later ordinal with older timestamp'),
      new ThinkingMessage('2024-01-01T00:00:01Z', 'latest ordinal'),
    ]);

    expect(activity.lastActivityAt).toBe('2024-01-01T00:00:02Z');
    expect(summarizeTranscriptActivity([]).lastActivityAt).toBeNull();
  });

  it('summarizes plain decoded rows the same way as class instances', () => {
    const activity = summarizeTranscriptActivity([
      { type: 'assistant-message', timestamp: '2024-01-01T00:00:00Z', content: 'decoded\nrow' },
    ]);

    expect(activity.preview).toEqual({ content: 'decoded', timestamp: '2024-01-01T00:00:00Z' });
  });

  it('reports plan-mode entry and plan approval requests', () => {
    const exit = new ExitPlanModeToolUseMessage('2024-01-01T00:00:02Z', 'tool-exit', 'Synthetic plan');
    const activity = summarizeTranscriptActivity([
      new EnterPlanModeToolUseMessage('2024-01-01T00:00:01Z', 'tool-enter'),
      exit,
    ]);

    expect(activity.planModeEntered).toBe(true);
    expect(activity.planExitRequests).toEqual([exit]);
    expect(summarizeTranscriptActivity([new AssistantMessage('2024-01-01T00:00:00Z', 'x')]))
      .toMatchObject({ planModeEntered: false, planExitRequests: [] });
  });
});

describe('parseChatTranscriptActivity', () => {
  it('round-trips a serialized summary', () => {
    const activity = summarizeTranscriptActivity([
      new AssistantMessage('2024-01-01T00:00:00Z', 'answer'),
      new ExitPlanModeToolUseMessage('2024-01-01T00:00:01Z', 'tool-exit', 'Synthetic plan'),
    ]);
    const parsed = parseChatTranscriptActivity(JSON.parse(JSON.stringify(activity)));

    expect(parsed).toEqual(activity);
    expect(parsed?.planExitRequests[0]).toBeInstanceOf(ExitPlanModeToolUseMessage);
  });

  it('rejects malformed summaries', () => {
    const valid = { preview: null, lastActivityAt: null, planModeEntered: false, planExitRequests: [] };
    expect(parseChatTranscriptActivity(valid)).toEqual(valid);
    expect(parseChatTranscriptActivity(null)).toBeNull();
    expect(parseChatTranscriptActivity({ ...valid, preview: { content: 'x' } })).toBeNull();
    expect(parseChatTranscriptActivity({ ...valid, lastActivityAt: 1 })).toBeNull();
    expect(parseChatTranscriptActivity({ ...valid, planModeEntered: 'yes' })).toBeNull();
    expect(parseChatTranscriptActivity({
      ...valid,
      planExitRequests: [{ type: 'assistant-message', timestamp: 't', content: 'x' }],
    })).toBeNull();
  });
});
