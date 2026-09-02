import { describe, expect, it } from 'vitest';
import {
	extractPreviewFirstLine,
	selectLatestActivityTimestampFromBatch,
	selectPreviewFromBatch,
} from '../chat-message-batch-activity.js';
import {
	AssistantMessage,
	ErrorMessage,
	ThinkingMessage,
	ToolResultMessage,
	TranscriptNoticeMessage,
	UnknownToolUseMessage,
	UserMessage,
	type ChatMessage,
} from '$shared/chat-types';

describe('extractPreviewFirstLine', () => {
	it('returns text before first newline', () => {
		expect(extractPreviewFirstLine('first\nsecond\nthird')).toBe('first');
	});

	it('returns full text when no newline', () => {
		expect(extractPreviewFirstLine('single line')).toBe('single line');
	});

	it('trims whitespace', () => {
		expect(extractPreviewFirstLine('  padded  \nmore')).toBe('padded');
	});

	it('returns empty string for empty input', () => {
		expect(extractPreviewFirstLine('')).toBe('');
	});
});

describe('selectPreviewFromBatch', () => {
	it('returns first line from the latest assistant message', () => {
		const messages: ChatMessage[] = [
			new UserMessage('2024-01-01T00:00:00Z', 'hello'),
			new UnknownToolUseMessage('2024-01-01T00:00:01Z', 't1', 'ls', {}),
			new AssistantMessage('2024-01-01T00:00:02Z', 'first line\nsecond line'),
		];

		expect(selectPreviewFromBatch(messages)).toEqual({
			content: 'first line',
			timestamp: '2024-01-01T00:00:02Z',
		});
	});

	it('returns full content when no newline present', () => {
		const messages: ChatMessage[] = [
			new AssistantMessage('2024-01-01T00:00:00Z', 'single line response'),
		];

		expect(selectPreviewFromBatch(messages)).toEqual({
			content: 'single line response',
			timestamp: '2024-01-01T00:00:00Z',
		});
	});

	it('returns null when no displayable message exists', () => {
		const messages: ChatMessage[] = [
			new UnknownToolUseMessage('2024-01-01T00:00:01Z', 't1', 'ls', {}),
			new ToolResultMessage('2024-01-01T00:00:02Z', 't1', {}, false),
		];

		expect(selectPreviewFromBatch(messages)).toBeNull();
	});

	it('ignores presentation-only error and notice messages', () => {
		const error = new ErrorMessage('2024-01-01T00:00:02Z', 'first error line\nsecond');
		expect(
			selectPreviewFromBatch([
				new TranscriptNoticeMessage('2024-01-01T00:00:01Z', 'presentation only'),
				error,
			]),
		).toBeNull();
		expect(
			selectPreviewFromBatch([
				new TranscriptNoticeMessage('2024-01-01T00:00:03Z', 'presentation only'),
			]),
		).toBeNull();
	});

	it('ignores newer thinking content and keeps the latest user or assistant preview', () => {
		const messages: ChatMessage[] = [
			new UserMessage('2024-01-01T00:00:00Z', 'hello'),
			new ThinkingMessage('2024-01-01T00:00:01Z', 'working on it\nstep two'),
		];

		expect(selectPreviewFromBatch(messages)).toEqual({
			content: 'hello',
			timestamp: '2024-01-01T00:00:00Z',
		});
		expect(
			selectPreviewFromBatch([new ThinkingMessage('2024-01-01T00:00:01Z', 'working on it')]),
		).toBeNull();
	});

	it('truncates content to 200 characters', () => {
		const messages: ChatMessage[] = [new AssistantMessage('2024-01-01T00:00:00Z', 'a'.repeat(300))];

		expect(selectPreviewFromBatch(messages)?.content.length).toBe(200);
	});

	it('returns null for empty message array', () => {
		expect(selectPreviewFromBatch([])).toBeNull();
	});
});

describe('selectLatestActivityTimestampFromBatch', () => {
	it('tracks the latest transcript activity independently of preview eligibility', () => {
		const messages: ChatMessage[] = [
			new ThinkingMessage('2024-01-01T00:00:02Z', 'newer activity'),
			new AssistantMessage('2024-01-01T00:00:00Z', 'later ordinal with older timestamp'),
			new ThinkingMessage('2024-01-01T00:00:01Z', 'latest ordinal'),
		];

		expect(selectLatestActivityTimestampFromBatch(messages)).toBe('2024-01-01T00:00:02Z');
		expect(selectLatestActivityTimestampFromBatch([])).toBeNull();
	});
});
