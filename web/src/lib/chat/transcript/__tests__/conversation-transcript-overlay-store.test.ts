import { describe, expect, it } from 'vitest';
import { UserMessage } from '$shared/chat-types';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import { emptyChatExecutionControlState } from '$shared/chat-execution-control';
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
	it.each(['snapshot', 'commit'] as const)('copies only the freshness identity from a %s publication', source => {
		const overlays = new ConversationTranscriptOverlayStore();
		const publication = {
			chatId: 'chat-1', transcriptViewId: 'synthetic-view', lastOrdinal: 100,
			messages: [echoed('input-100', 100)], resendCandidates: [candidate(100)], noticeRevision: 0,
		};
		if (source === 'snapshot') overlays.publishSnapshotResendCandidates('chat-1', publication.resendCandidates, publication);
		else overlays.applyCommittedBatch(publication);
		publication.lastOrdinal = 0;
		overlays.publishSnapshotResendCandidates('chat-1', [candidate(50)], { transcriptViewId: 'synthetic-view', lastOrdinal: 50 });
		expect(overlays.forChat('chat-1').resendCandidates).toEqual([candidate(100)]);
	});

	it('reads a missing chat without creating reactive state', () => {
		const overlays = new ConversationTranscriptOverlayStore();

		expect(overlays.viewFor('chat-1')).toBeNull();

		overlays.appendLocalNotice('chat-1', 'progress', 'working');

		expect(overlays.viewFor('chat-1')?.notices).toHaveLength(1);
	});

	it('retains observed echoes until presentation catches up, even after queue controls disappear', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		const chatId = 'chat-1';
		const control = emptyChatExecutionControlState('server');
		const input = optimistic('own');
		control.queue.entries = [{ id: 'entry', kind: 'steer', attachments: [], content: input.content,
			revision: 1, createdAt: input.createdAt, updatedAt: input.createdAt }];
		overlays.upsertOptimisticInput(chatId, input, 1);
		overlays.reconcileQueuedSteers(chatId, control, {
			clientMessageId: 'own', entryId: 'entry', serverInstanceId: 'server', transcriptViewId: 'view',
		});
		overlays.clearEchoedInputs(chatId, [echoed('own', 2), echoed('not-local', 3)], 1);
		overlays.reconcileQueuedSteers(chatId, null);
		expect(overlays.forChat(chatId).optimisticInputs).toHaveLength(1);
		overlays.upsertOptimisticInput(chatId, optimistic('later'), 1);
		overlays.clearEchoedInputs(chatId, [], 2);
		expect(overlays.forChat(chatId).optimisticInputs.map(input => input.clientMessageId)).toEqual(['later']);
		expect(overlays.forChat(chatId).optimisticAfterOrdinals.get('later')).toBe(2);
		overlays.upsertOptimisticInput(chatId, optimistic('not-local'), 3);
		overlays.clearEchoedInputs(chatId, [], 3);
		expect(overlays.forChat(chatId).optimisticInputs).toHaveLength(2);
	});

	it.each(['clear', 'replacement', 'prune'] as const)('drops retained echo evidence on %s', cleanup => {
		const overlays = new ConversationTranscriptOverlayStore();
		const chatId = 'chat-1', input = optimistic('own');
		overlays.upsertOptimisticInput(chatId, input, 1);
		overlays.clearEchoedInputs(chatId, [echoed('own', 2)], 1);
		if (cleanup === 'clear') overlays.clearOptimisticInput(chatId, 'own');
		else if (cleanup === 'replacement') overlays.resetForTranscriptReplacement(chatId);
		else overlays.prune(new Set());
		overlays.upsertOptimisticInput(chatId, input, 1);
		overlays.clearEchoedInputs(chatId, [], 2);
		expect(overlays.forChat(chatId).optimisticInputs).toEqual([input]);
	});

	it('returns one stable chat-qualified view', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		const first = overlays.forChat('chat-1');
		const second = overlays.forChat('chat-1');
		const other = overlays.forChat('chat-2');

		overlays.appendLocalNotice('chat-1', 'progress', 'working');
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), 4);

		expect(second).toBe(first);
		expect(first.notices).toHaveLength(0);
		expect(first.optimisticInputs).toHaveLength(1);
		expect(first.optimisticAfterOrdinals.get('input-1')).toBe(4);
		expect(other.notices).toHaveLength(0);
	});

	it('clears only overlays captured by an applied batch', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), 2);
		overlays.upsertOptimisticInput('chat-1', optimistic('input-2'), 2);
		overlays.appendLocalNotice('chat-1', 'progress', 'before');
		const capturedRevision = overlays.noticeRevisionFor('chat-1');
		overlays.appendLocalNotice('chat-1', 'error', 'after');
		overlays.excludeResendCandidate('chat-1', 1);

		const mutation = overlays.applyCommittedBatch({
			chatId: 'chat-1',
			transcriptViewId: 'synthetic-view',
			lastOrdinal: 3,
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

	it('follows only its own queued steer across edits and dispatch before echo', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		const chatId = 'chat-1';
		const receipt = { clientMessageId: 'input-1', entryId: 'entry-1', serverInstanceId: 'server-1', transcriptViewId: 'view' };
		const input = optimistic(receipt.clientMessageId);
		const control = emptyChatExecutionControlState(receipt.serverInstanceId);
		const entry = { id: receipt.entryId, content: 'edited guidance', kind: 'steer' as const,
			attachments: [], revision: 2, createdAt: input.createdAt, updatedAt: input.createdAt };
		control.queue.entries = [entry, { ...entry, id: 'from-another-tab' }];
		overlays.upsertOptimisticInput(chatId, input, 7);
		const view = overlays.forChat(chatId);
		overlays.reconcileQueuedSteers(chatId, control);
		expect(view.optimisticInputs).toEqual([input]);
		overlays.reconcileQueuedSteers(chatId, control, receipt);
		expect(view.optimisticInputs).toEqual([{ ...input, delivery: { ...receipt, kind: 'queued', queuedAtVersion: control.version }, content: entry.content }]);
		expect(view.optimisticAfterOrdinals.get(input.clientMessageId)).toBe(7);
		expect(overlays.reconcileQueuedSteers(chatId, control)?.feedStructureChanged).toBe(false);

		control.queue.entries = [];
		control.queue.recentlyDispatched = [{ entryId: entry.id, revision: 2, dispatchedAt: input.createdAt }];
		overlays.reconcileQueuedSteers(chatId, control);
		expect(view.optimisticInputs).toHaveLength(1);
		overlays.applyCommittedBatch({ chatId, transcriptViewId: 'view', lastOrdinal: 8,
			messages: [echoed(input.clientMessageId, 8)], resendCandidates: [], noticeRevision: 0 });
		overlays.reconcileQueuedSteers(chatId, control, receipt);
		expect(view.optimisticInputs).toEqual([]);
		expect(view.optimisticAfterOrdinals.size).toBe(0);
	});

	it.each(['removed', 'restart', 'pruned'] as const)('drops only the queued row when its entry is %s', reason => {
		const overlays = new ConversationTranscriptOverlayStore();
		const receipt = { clientMessageId: 'own', entryId: 'entry', serverInstanceId: 'server', transcriptViewId: 'view' };
		const control = emptyChatExecutionControlState(receipt.serverInstanceId);
		const input = optimistic(receipt.clientMessageId);
		const other = optimistic('still-in-flight');
		const delivered = { ...optimistic('immediate'), delivery: {
			kind: 'delivered' as const, clientMessageId: 'immediate', transcriptViewId: 'view',
		} };
		control.queue.entries = [{ id: receipt.entryId, kind: 'steer', attachments: [], content: input.content,
			revision: 1, createdAt: input.createdAt, updatedAt: input.createdAt }];
		for (const row of [input, other, delivered]) overlays.upsertOptimisticInput(row.chatId, row, 3);
		overlays.reconcileQueuedSteers(input.chatId, control, receipt);
		if (reason === 'removed') control.queue.entries = [];
		if (reason === 'restart') control.serverInstanceId = 'new-server';
		const latest = reason === 'pruned' ? null : control;
		overlays.reconcileQueuedSteers(input.chatId, latest);
		overlays.reconcileQueuedSteers(input.chatId, latest, receipt);
		const view = overlays.forChat(input.chatId);
		expect(view.optimisticInputs).toEqual([other, delivered]);
		expect([...view.optimisticAfterOrdinals]).toEqual([[other.clientMessageId, 3], [delivered.clientMessageId, 3]]);
	});

	it('recognizes cancellation from the latest observation of a long-waiting queue entry', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		const input = optimistic('own');
		const receipt = { clientMessageId: input.clientMessageId, entryId: 'entry', serverInstanceId: 'server', transcriptViewId: 'view' };
		const control = emptyChatExecutionControlState(receipt.serverInstanceId);
		control.queue.entries = [{ id: receipt.entryId, kind: 'steer', attachments: [], content: input.content,
			revision: 1, createdAt: input.createdAt, updatedAt: input.createdAt }];
		overlays.upsertOptimisticInput(input.chatId, input, 3);
		overlays.reconcileQueuedSteers(input.chatId, control, receipt);
		control.version += 100;
		overlays.reconcileQueuedSteers(input.chatId, control);
		control.version++;
		control.queue.entries = [];
		overlays.reconcileQueuedSteers(input.chatId, control);
		expect(overlays.forChat(input.chatId).optimisticInputs).toEqual([]);
	});

	it('clears prior notices only when a new optimistic submission begins', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.appendServerNotice('chat-1', 'error', 'Exit 127');
		overlays.appendLocalNotice('chat-2', 'warning', 'Other chat');
		overlays.upsertOptimisticInput('chat-1', optimistic('input-1'), 2);
		expect(overlays.forChat('chat-1').notices).toEqual([]);
		expect(overlays.forChat('chat-2').notices).toHaveLength(1);

		overlays.appendServerNotice('chat-1', 'warning', 'Delivery uncertain');
		overlays.upsertOptimisticInput('chat-1', { ...optimistic('input-1'), delivery: 'delivered' }, 2);
		expect(overlays.forChat('chat-1').notices.map(notice => notice.content)).toEqual(['Delivery uncertain']);
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
			transcriptViewId: 'synthetic-view',
			lastOrdinal: 1,
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

	it('accepts an admitted replacement snapshot without comparing ordinals across views', () => {
		const overlays = new ConversationTranscriptOverlayStore();
		overlays.publishSnapshotResendCandidates('chat-1', [], { transcriptViewId: 'old-view', lastOrdinal: 100 });
		const candidates = [{ ordinal: 1, content: 'Synthetic replacement input', attachmentNames: [] }];
		overlays.publishSnapshotResendCandidates('chat-1', candidates, { transcriptViewId: 'new-view', lastOrdinal: 1 });
		expect(overlays.forChat('chat-1').includedResendCandidates).toEqual(candidates);
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
