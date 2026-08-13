import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { ChatViewMessage } from '$shared/chat-view';
import { validateRequestedTranscriptPage } from '../transcript-page-progress.js';

const TS = '2026-08-13T00:00:00.000Z';

function messages(firstSeq: number, count: number): ChatViewMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		seq: firstSeq + index,
		message: new AssistantMessage(TS, `message-${firstSeq + index}`),
	}));
}

describe('transcript page request validation', () => {
	it.each([
		{
			name: 'latest suffix',
			request: { limit: 50 },
			page: {
				limit: 50,
				lastSeq: 120,
				pageOldestSeq: 71,
				hasMore: true,
				messages: messages(71, 50),
			},
		},
		{
			name: 'full short transcript',
			request: { limit: 50 },
			page: {
				limit: 50,
				lastSeq: 20,
				pageOldestSeq: 1,
				hasMore: false,
				messages: messages(1, 20),
			},
		},
		{
			name: 'first detached window',
			request: { limit: 50, beforeSeq: 51 },
			page: {
				limit: 50,
				lastSeq: 120,
				pageOldestSeq: 1,
				hasMore: false,
				messages: messages(1, 50),
			},
		},
		{
			name: 'middle window',
			request: { limit: 50, beforeSeq: 101 },
			page: {
				limit: 50,
				lastSeq: 120,
				pageOldestSeq: 51,
				hasMore: true,
				messages: messages(51, 50),
			},
		},
		{
			name: 'empty transcript',
			request: { limit: 50 },
			page: {
				limit: 50,
				lastSeq: 0,
				pageOldestSeq: 0,
				hasMore: false,
				messages: [],
			},
		},
	])('accepts an exact $name', ({ request, page }) => {
		expect(validateRequestedTranscriptPage(request, page)).toBe(true);
	});

	it.each([
		{
			name: 'reversed sequence',
			change: { messages: messages(51, 50).reverse() },
		},
		{
			name: 'sequence gap',
			change: { messages: [...messages(51, 25), ...messages(77, 25)] },
		},
		{
			name: 'duplicate sequence',
			change: { messages: [...messages(51, 25), ...messages(75, 25)] },
		},
		{
			name: 'short interior page',
			change: { messages: messages(61, 40), pageOldestSeq: 61 },
		},
		{
			name: 'wrong oldest metadata',
			change: { pageOldestSeq: 50 },
		},
		{
			name: 'wrong continuation metadata',
			change: { hasMore: false },
		},
		{
			name: 'wrong echoed limit',
			change: { limit: 49 },
		},
	])('rejects a $name', ({ change }) => {
		const page = {
			limit: 50,
			lastSeq: 120,
			pageOldestSeq: 51,
			hasMore: true,
			messages: messages(51, 50),
			...change,
		};
		expect(validateRequestedTranscriptPage({ limit: 50, beforeSeq: 101 }, page)).toBe(false);
	});
});
