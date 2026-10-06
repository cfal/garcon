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
		message: new UserMessage('2026-08-30T00:00:01.000Z', 'committed input', undefined, {
			clientMessageId,
		}),
	};
}

describe('ConversationTranscriptOverlayStore', () => {
	it('confirms delivery on observed echoes without settling their buffered rows', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), 1);
		overlays.upsertOptimisticInput('chat-1', optimistic('input-2'), 1);
		expect(overlays.observeEchoes('chat-1', 'view-1', [echoed('input-1', 101)]).feedStructureChanged).toBe(true);
		expect(overlays.forChat('chat-1').optimisticInputs.map((input) => input.delivery)).toEqual(['delivered', 'pending']);
		expect(overlays.forChat('chat-1').optimisticAfterOrdinals.get('input-1')).toBe(1);
		expect(overlays.observeEchoes('chat-1', 'view-1', [echoed('input-1', 101)]).feedStructureChanged).toBe(false);
	});

	it('settles retained echo addresses only after a same-view snapshot covers them', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), null);
		overlays.observeEchoes('chat-1', 'view-1', [echoed('input-1', 101)]);
		overlays.settleSnapshot('chat-1', 'view-2', [], 200);
		expect(overlays.forChat('chat-1').optimisticInputs).toHaveLength(1);
		overlays.settleSnapshot('chat-1', 'view-1', [], 100);
		expect(overlays.forChat('chat-1').optimisticInputs).toHaveLength(1);
		overlays.settleSnapshot('chat-1', 'view-1', [], 200);
		expect(overlays.forChat('chat-1').optimisticInputs).toHaveLength(0);
	});

	it.each(['clear', 'replace', 'remove', 'prune'] as const)('discards echo evidence on %s rather than settling a later submission', (operation) => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), null);
		overlays.observeEchoes('chat-1', 'view-1', [echoed('input-1', 101)]);
		if (operation === 'clear') overlays.clearOptimisticInput('chat-1', 'input-1');
		else if (operation === 'replace') overlays.resetForTranscriptReplacement('chat-1');
		else if (operation === 'remove') overlays.remove('chat-1');
		else overlays.prune(new Set());
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), null);
		overlays.settleSnapshot('chat-1', 'view-1', [], 200);
		expect(overlays.forChat('chat-1').optimisticInputs).toHaveLength(1);
	});

	it('reads a missing chat without creating reactive state', () => {
		const overlays = new ConversationTranscriptOverlayStore();

		expect(overlays.viewFor('chat-1')).toBeNull();

		overlays.appendLocalNotice('chat-1', 'progress', 'working');

		expect(overlays.viewFor('chat-1')?.notices).toHaveLength(1);
	});

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

	it('clears notices through a captured revision while keeping later ones', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.appendLocalNotice('chat-1', 'progress', 'forking');
		const capturedRevision = overlays.noticeRevisionFor('chat-1');
		overlays.appendLocalNotice('chat-1', 'error', 'failed');

		const mutation = overlays.clearNoticesThrough('chat-1', capturedRevision);

		expect(mutation.feedStructureChanged).toBe(true);
		expect(overlays.forChat('chat-1').notices.map((notice) => notice.content)).toEqual([
			'failed',
		]);

		overlays.clearNoticesThrough('chat-1');

		expect(overlays.forChat('chat-1').notices).toEqual([]);
	});

	it('keeps notice revisions monotonic across transcript replacement', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.appendLocalNotice('chat-1', 'progress', 'forking');
		const capturedRevision = overlays.noticeRevisionFor('chat-1');
		overlays.resetForTranscriptReplacement('chat-1');
		overlays.appendLocalNotice('chat-1', 'error', 'failed');

		overlays.clearNoticesThrough('chat-1', capturedRevision);

		expect(overlays.forChat('chat-1').notices.map((notice) => notice.content)).toEqual([
			'failed',
		]);
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

	it('suppresses only adjacent duplicate server notices', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.appendServerNotice('chat-1', 'warning', 'native history changed');
		const revision = overlays.noticeRevisionFor('chat-1');
		const firstNoticeId = overlays.forChat('chat-1').notices[0]?.id;

		const duplicate = overlays.appendServerNotice(
			'chat-1',
			'warning',
			'native history changed',
		);

		expect(duplicate.feedStructureChanged).toBe(false);
		expect(overlays.noticeRevisionFor('chat-1')).toBe(revision);
		expect(overlays.forChat('chat-1').notices.map((notice) => notice.content)).toEqual([
			'native history changed',
		]);

		overlays.applyCommittedBatch({
			chatId: 'chat-1',
			messages: [echoed('input-1', 1)],
			resendCandidates: [],
			noticeRevision: revision,
		});
		overlays.appendServerNotice('chat-1', 'warning', 'native history changed');

		expect(overlays.forChat('chat-1').notices).toHaveLength(1);
		expect(overlays.forChat('chat-1').notices[0]?.id).not.toBe(firstNoticeId);

		overlays.appendServerNotice('chat-1', 'info', 'intervening notice');
		overlays.appendServerNotice('chat-1', 'warning', 'native history changed');

		expect(overlays.forChat('chat-1').notices.map((notice) => notice.content)).toEqual([
			'native history changed',
			'intervening notice',
			'native history changed',
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

	it('does not recreate a removed chat for late optimistic settlement', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), 1);
		overlays.remove('chat-1');

		expect(overlays.markOptimisticInputDelivered('chat-1', 'input-1')).toBeNull();
		expect(overlays.clearOptimisticInput('chat-1', 'input-1')).toBeNull();
		expect(overlays.viewFor('chat-1')).toBeNull();
	});
});
