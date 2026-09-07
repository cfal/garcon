import { describe, expect, it } from 'vitest';
import {
	applyTranscriptAppend,
	parseTranscriptMessage,
	parseTranscriptMessages,
	type TranscriptMessage,
} from '$shared/chat-view';
import { AssistantMessage, ErrorMessage } from '$shared/chat-types';

const message = { type: 'assistant-message', timestamp: '2025-01-01T00:00:00Z', content: 'hi' };

describe('chat view helpers', () => {
	it('parses a valid chat view message envelope', () => {
		const entry = parseTranscriptMessage({ ordinal: 1, message });

		expect(entry?.ordinal).toBe(1);
		expect(entry?.message).toBeInstanceOf(AssistantMessage);
		expect((entry?.message as AssistantMessage).content).toBe('hi');
	});

	it('rejects malformed or non-increasing batches', () => {
		expect(parseTranscriptMessages([{ ordinal: 0, message }])).toBeNull();
		expect(
			parseTranscriptMessages([
				{ ordinal: 1, message },
				{ ordinal: 1, message },
			]),
		).toBeNull();
	});

	it('keeps unknown inner messages as error placeholders', () => {
		const entries = parseTranscriptMessages([
			{ ordinal: 1, message: { type: 'future-message', timestamp: '2025-01-01T00:00:00Z' } },
		]);

		expect(entries?.[0].message).toBeInstanceOf(ErrorMessage);
	});

	it('applies only messages beyond the current cursor', () => {
		const current: TranscriptMessage[] = [
			{ ordinal: 1, message: parseTranscriptMessage({ ordinal: 1, message })!.message },
		];
		const incoming: TranscriptMessage[] = [
			{ ordinal: 1, message: parseTranscriptMessage({ ordinal: 1, message })!.message },
			{ ordinal: 2, message: parseTranscriptMessage({ ordinal: 2, message })!.message },
		];

		const applied = applyTranscriptAppend(current, {
			firstOrdinal: 1,
			lastOrdinal: 2,
			messages: incoming,
		}, 1);

		expect(applied.status).toBe('applied');
		expect(applied.changed).toBe(true);
		expect(applied.messages.map((entry) => entry.ordinal)).toEqual([1, 2]);
		expect(applied.lastOrdinal).toBe(2);
	});

	it('detects a gap before the first new message', () => {
		const current: TranscriptMessage[] = [
			{ ordinal: 1, message: parseTranscriptMessage({ ordinal: 1, message })!.message },
		];
		const incoming: TranscriptMessage[] = [
			{ ordinal: 3, message: parseTranscriptMessage({ ordinal: 3, message })!.message },
		];

		const applied = applyTranscriptAppend(current, {
			firstOrdinal: 3,
			lastOrdinal: 3,
			messages: incoming,
		}, 1);

		expect(applied).toMatchObject({
			status: 'gap-detected',
			changed: false,
			lastOrdinal: 1,
			expectedOrdinal: 2,
			receivedOrdinal: 3,
		});
		expect(applied.messages).toBe(current);
	});

	it('allows hidden ledger rows between rendered messages', () => {
		const current: TranscriptMessage[] = [
			{ ordinal: 1, message: parseTranscriptMessage({ ordinal: 1, message })!.message },
		];
		const incoming: TranscriptMessage[] = [
			{ ordinal: 2, message: parseTranscriptMessage({ ordinal: 2, message })!.message },
			{ ordinal: 4, message: parseTranscriptMessage({ ordinal: 4, message })!.message },
		];

		const applied = applyTranscriptAppend(current, {
			firstOrdinal: 2,
			lastOrdinal: 4,
			messages: incoming,
		}, 1);

		expect(applied.status).toBe('applied');
		expect(applied.lastOrdinal).toBe(4);
		expect(applied.messages.map((entry) => entry.ordinal)).toEqual([1, 2, 4]);
	});
});
