import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import {
	ConversationFeedAnnouncerState,
	plainAnnouncementText,
} from '../conversation-feed-announcer';
import type { ConversationFeedMutationClock } from '$lib/chat/transcript/conversation-feed-mutations';

function clock(dataRevision: number, liveAppendRevision = 0): ConversationFeedMutationClock {
	return {
		dataRevision,
		lastRevisionByKind: {
			initial: 0,
			'live-append': liveAppendRevision,
			'history-earlier': 0,
			'history-later': 0,
			replacement: 0,
			'presentation-structure': 0,
		},
	};
}

function assistantRow(id: string, content: string) {
	return {
		kind: 'message' as const,
		id,
		seq: Number(id),
		message: new AssistantMessage('2026-01-01T00:00:00.000Z', content),
	};
}

const enabled = {
	visible: true,
	pinnedToBottom: true,
	isLiveWindow: true,
	detachedStatus: 'New response available',
};

describe('ConversationFeedAnnouncerState', () => {
	it('does not announce the initial or replacement transcript', () => {
		const announcer = new ConversationFeedAnnouncerState();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing')],
				mutationClock: clock(1),
				...enabled,
			}),
		).toBe('');
	});

	it('announces only newly appended visible conversation text at the live end', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'new response')],
				mutationClock: clock(2, 2),
				...enabled,
			}),
		).toBe('new response');
	});

	it('acknowledges hidden and detached appends without replaying them later', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'while detached')],
				mutationClock: clock(2, 2),
				...enabled,
				visible: false,
				pinnedToBottom: false,
			}),
		).toBe('');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'while detached')],
				mutationClock: clock(2, 2),
				...enabled,
			}),
		).toBeNull();
	});

	it('emits one concise status while visibly detached', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'existing')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'existing'), assistantRow('2', 'first unseen response')],
				mutationClock: clock(2, 2),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBe('New response available');
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					assistantRow('2', 'first unseen response'),
					assistantRow('3', 'second unseen response'),
				],
				mutationClock: clock(3, 3),
				...enabled,
				pinnedToBottom: false,
			}),
		).toBeNull();
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [
					assistantRow('1', 'existing'),
					assistantRow('2', 'first unseen response'),
					assistantRow('3', 'second unseen response'),
				],
				mutationClock: clock(3, 3),
				...enabled,
			}),
		).toBe('');
	});

	it('announces only the newly streamed suffix at the live end', () => {
		const announcer = new ConversationFeedAnnouncerState();
		announcer.reconcile({
			surfaceIdentity: 'chat:generation',
			rows: [assistantRow('1', 'Hello')],
			mutationClock: clock(1),
			...enabled,
		});
		expect(
			announcer.reconcile({
				surfaceIdentity: 'chat:generation',
				rows: [assistantRow('1', 'Hello world')],
				mutationClock: clock(2, 2),
				...enabled,
			}),
		).toBe('world');
	});

	it('flattens Markdown without exposing formatting punctuation', () => {
		expect(plainAnnouncementText('## See [the file](/tmp/file) and `value`')).toBe(
			'See the file and value',
		);
	});
});
