import { describe, it, expect } from 'vitest';
import { applyChatMessages } from '../reducer';
import {
	UserMessage,
	AssistantMessage,
	ThinkingMessage,
	ToolResultMessage,
	ReadToolUseMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';

describe('applyChatMessages', () => {
	it('appends messages to an empty array', () => {
		const result = applyChatMessages([], [
			new UserMessage('2026-01-01T00:00:00Z', 'Hello'),
		]);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe('user-message');
	});

	it('appends messages to existing array', () => {
		const current: ChatMessage[] = [
			new UserMessage('2026-01-01T00:00:00Z', 'Question'),
		];
		const result = applyChatMessages(current, [
			new AssistantMessage('2026-01-01T00:00:01Z', 'Answer'),
		]);
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe('user-message');
		expect(result[1].type).toBe('assistant-message');
	});

	it('returns current array unchanged when incoming is empty', () => {
		const current: ChatMessage[] = [
			new UserMessage('2026-01-01T00:00:00Z', 'Hello'),
		];
		const result = applyChatMessages(current, []);
		expect(result).toBe(current);
	});

	it('appends multiple messages in a single batch', () => {
		const result = applyChatMessages([], [
			new UserMessage('2026-01-01T00:00:00Z', 'Question'),
			new AssistantMessage('2026-01-01T00:00:01Z', 'I will help you.'),
			new ReadToolUseMessage('2026-01-01T00:00:02Z', 't1', '/tmp/file.ts'),
			new ToolResultMessage('2026-01-01T00:00:03Z', 't1', { raw: 'file content' }, false),
		]);
		expect(result).toHaveLength(4);
		expect(result[0].type).toBe('user-message');
		expect(result[1].type).toBe('assistant-message');
		expect(result[2].type).toBe('read-tool-use');
		expect(result[3].type).toBe('tool-result');
	});

	it('preserves original array immutably', () => {
		const current: ChatMessage[] = [
			new UserMessage('2026-01-01T00:00:00Z', 'Hello'),
		];
		const result = applyChatMessages(current, [
			new AssistantMessage('2026-01-01T00:00:01Z', 'Hi'),
		]);
		expect(current).toHaveLength(1);
		expect(result).toHaveLength(2);
		expect(result).not.toBe(current);
	});

	it('handles thinking messages', () => {
		const result = applyChatMessages([], [
			new ThinkingMessage('2026-01-01T00:00:00Z', 'Reasoning...'),
			new AssistantMessage('2026-01-01T00:00:01Z', 'Done'),
		]);
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe('thinking');
		expect(result[1].type).toBe('assistant-message');
	});
});
