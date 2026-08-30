import { describe, expect, it } from 'vitest';
import { UserMessage } from '$shared/chat-types';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import { ConversationTranscriptOverlayStore } from '../conversation-transcript-overlay-store.svelte.js';

function candidate(ordinal: number): ResendCandidate {
	return { ordinal, content: `candidate-${ordinal}`, attachmentNames: [] };
}

function optimistic(clientMessageId: string) {
	return {
		chatId: 'chat-1',
		clientMessageId,
		content: `optimistic-${clientMessageId}`,
		createdAt: '2026-08-30T00:00:00.000Z',
		delivery: 'pending' as const,
	};
}

function echoed(clientMessageId: string, ordinal: number): TranscriptMessage {
	return {
		ordinal,
		message: new UserMessage(
			'2026-08-30T00:00:01.000Z',
			'committed input',
			undefined,
			{ clientMessageId },
		),
	};
}

describe('ConversationTranscriptOverlayStore', () => {
	it('returns one stable chat-qualified view', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		const first = overlays.forChat('chat-1');
		const second = overlays.forChat('chat-1');
		const other = overlays.forChat('chat-2');

		overlays.appendLocalNotice('chat-1', 'progress', 'working');
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), 4);

		expect(second).toBe(first);
		expect(first.notices).toHaveLength(1);
		expect(first.optimisticInputs).toHaveLength(1);
		expect(first.optimisticAfterOrdinals.get('input-1')).toBe(4);
		expect(other.notices).toHaveLength(0);
	});

	it('clears only overlays captured by an applied batch', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.appendLocalNotice('chat-1', 'progress', 'before');
		const capturedRevision = overlays.noticeRevisionFor('chat-1');
		overlays.appendLocalNotice('chat-1', 'error', 'after');
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), 2);
		overlays.upsertOptimisticInput('chat-1', optimistic('input-2'), 2);
		overlays.excludeResendCandidate('chat-1', 1);

		const mutation = overlays.applyCommittedBatch({
			chatId: 'chat-1',
			messages: [echoed('input-1', 3)],
			resendCandidates: [candidate(3)],
			noticeRevision: capturedRevision,
		});
		const view = overlays.forChat('chat-1');

		expect(mutation.feedStructureChanged).toBe(true);
		expect(view.notices.map((notice) => notice.content)).toEqual(['after']);
		expect(view.optimisticInputs.map((input) => input.clientMessageId)).toEqual(['input-2']);
		expect(view.optimisticAfterOrdinals.get('input-2')).toBe(3);
		expect(view.resendCandidates).toEqual([candidate(3)]);
	});

	it('preserves stable resend exclusions until their candidate departs', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.replaceResendCandidates('chat-1', [candidate(1), candidate(2)]);
		overlays.excludeResendCandidate('chat-1', 1);

		overlays.replaceResendCandidates('chat-1', [candidate(1), candidate(2)]);
		expect(overlays.forChat('chat-1').includedResendCandidates).toEqual([candidate(2)]);

		overlays.replaceResendCandidates('chat-1', [candidate(2)]);
		expect(overlays.forChat('chat-1').excludedResendOrdinals).toEqual([]);
	});

	it('bounds retained server notices per chat without dropping local notices', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.appendLocalNotice('chat-1', 'warning', 'local');
		for (let index = 0; index < 10; index += 1) {
			overlays.appendServerNotice('chat-1', 'progress', `server-${index}`);
		}

		expect(overlays.forChat('chat-1').notices.map((notice) => notice.content)).toEqual([
			'local',
			'server-2',
			'server-3',
			'server-4',
			'server-5',
			'server-6',
			'server-7',
			'server-8',
			'server-9',
		]);
	});

	it('prunes only chats outside the active session set', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.appendLocalNotice('chat-1', 'progress', 'one');
		overlays.appendLocalNotice('chat-2', 'progress', 'two');

		overlays.prune(new Set(['chat-2']));

		expect(overlays.forChat('chat-1').notices).toEqual([]);
		expect(overlays.forChat('chat-2').notices).toHaveLength(1);
	});
});
