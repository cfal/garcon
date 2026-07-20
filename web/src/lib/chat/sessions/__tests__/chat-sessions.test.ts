import { describe, it, expect } from 'vitest';
import { ChatSessionsStore } from '../chat-sessions.svelte';
import type { ChatSession } from '$lib/types/session';

function makeServerSession(overrides: Partial<ChatSession> = {}): ChatSession {
	return {
		id: 'a',
		agentId: 'claude',
		model: 'opus',
		title: 'A',
		projectPath: '/p',
		effectiveProjectKey: '/p',
		orderGroup: 'normal',
		tags: [],
		permissionMode: 'default',
		thinkingMode: 'none',
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isUnread: false,
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'auto' } },
		...overrides,
	};
}

describe('ChatSessionsStore', () => {
	it('preserves identity for unchanged records on upsert', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([
			makeServerSession({ id: 'a' }),
			makeServerSession({ id: 'b', title: 'B', projectPath: '/q' }),
		]);

		expect(store.byId['a']).toBe(ref);
		expect(store.byId['b']).toBeTruthy();
	});

	it('replaces record when fields change', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a', title: 'Old' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([makeServerSession({ id: 'a', title: 'New' })]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.title).toBe('New');
	});

	it('creates a pending draft and applies its projected start entry', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-1']?.status).toBe('draft');
		expect(store.byId['draft-1']?.title).toBe('Hello');
		expect(store.startupByChatId['draft-1']).toBeTruthy();
		expect(store.selectedChatId).toBe('draft-1');
		expect(store.order[0]).toBe('draft-1');

		store.applyStartEntry(makeServerSession({ id: 'draft-1', title: 'Hello' }));

		expect(store.byId['draft-1']?.status).toBe('running');
		expect(store.startupByChatId['draft-1']).toBeUndefined();
	});

	it('selectedChat derives from selectedChatId and byId', () => {
		const store = new ChatSessionsStore();

		expect(store.selectedChat).toBeNull();

		store.upsertFromServer([makeServerSession({ id: 'x', title: 'X' })]);
		store.setSelectedChatId('x');

		expect(store.selectedChat?.id).toBe('x');
		expect(store.selectedChat?.title).toBe('X');
		const selected = store.selectedChat;
		expect(store.selectedChat).toBe(selected);
	});

	it('orderedChats returns records in order', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({ id: 'a', title: 'A' }),
			makeServerSession({ id: 'b', title: 'B' }),
			makeServerSession({ id: 'c', title: 'C' }),
		]);

		const ids = store.orderedChats.map((c) => c.id);
		expect(ids).toEqual(['a', 'b', 'c']);
	});

	it('orderedChats reuses its array identity between unchanged reads', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([
			makeServerSession({ id: 'a', title: 'A' }),
			makeServerSession({ id: 'b', title: 'B' }),
		]);

		const first = store.orderedChats;

		expect(store.orderedChats).toBe(first);
	});

	it('removeChat clears byId, order, startup, and deselects', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Test',
			},
		});

		expect(store.selectedChatId).toBe('draft-1');

		store.removeChat('draft-1');

		expect(store.byId['draft-1']).toBeUndefined();
		expect(store.startupByChatId['draft-1']).toBeUndefined();
		expect(store.order).not.toContain('draft-1');
		expect(store.selectedChatId).toBeNull();
	});

	it('upsertFromServer cleans up startup for server-known chats', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Test',
			},
		});

		expect(store.startupByChatId['draft-1']).toBeTruthy();

		// Server now knows about this chat.
		store.upsertFromServer([makeServerSession({ id: 'draft-1', title: 'Test' })]);

		expect(store.startupByChatId['draft-1']).toBeUndefined();
		expect(store.byId['draft-1']?.status).toBe('running');
	});

	it('upsertFromServer preserves drafts not yet on server', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'local-draft',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Pending',
			},
		});

		store.upsertFromServer([makeServerSession({ id: 'server-chat', title: 'Server' })]);

		// Draft should still exist.
		expect(store.byId['local-draft']).toBeTruthy();
		expect(store.byId['local-draft']?.status).toBe('draft');
		// Draft should be before server chats in order.
		expect(store.order[0]).toBe('local-draft');
		expect(store.order[1]).toBe('server-chat');
	});

	it('patchPreview updates lastMessage', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.patchPreview('a', 'Hello world');

		expect(store.byId['a']?.lastMessage).toBe('Hello world');
	});

	it('patchPreview updates lastActivityAt when a preview timestamp is provided', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.patchPreview('a', 'Hello world', '2026-02-25T12:00:00.000Z');

		expect(store.byId['a']?.lastMessage).toBe('Hello world');
		expect(store.byId['a']?.lastActivityAt).toBe('2026-02-25T12:00:00.000Z');
	});

	it('patchPreview derives unread state when live activity advances past the read receipt', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: {
				createdAt: null,
				lastActivityAt: '2026-02-25T10:00:00.000Z',
				lastReadAt: '2026-02-25T10:00:00.000Z',
			},
			isUnread: false,
		})]);

		store.patchPreview('a', 'Background reply', '2026-02-25T12:00:00.000Z');

		expect(store.byId['a']?.lastActivityAt).toBe('2026-02-25T12:00:00.000Z');
		expect(store.byId['a']?.isUnread).toBe(true);
		store.patchLastReadAt('a', '2026-02-25T12:00:00.000Z');
		expect(store.byId['a']?.isUnread).toBe(false);
	});

	it('upsertFromServer does not erase a non-empty preview with a blank payload', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({ id: 'a', preview: { lastMessage: 'Persisted preview' } }),
		]);
		const ref = store.byId['a'];

		store.upsertFromServer([makeServerSession({ id: 'a', preview: { lastMessage: '' } })]);

		expect(store.byId['a']).toBe(ref);
		expect(store.byId['a']?.lastMessage).toBe('Persisted preview');
	});

	it('upsertFromServer does not let a stale list snapshot overwrite live activity', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: {
				createdAt: null,
				lastActivityAt: '2026-02-25T10:00:00.000Z',
				lastReadAt: '2026-02-25T10:00:00.000Z',
			},
			preview: { lastMessage: 'Initial message' },
		})]);
		store.patchPreview('a', 'Live background reply', '2026-02-25T12:00:00.000Z');

		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: {
				createdAt: null,
				lastActivityAt: '2026-02-25T11:00:00.000Z',
				lastReadAt: '2026-02-25T10:00:00.000Z',
			},
			preview: { lastMessage: 'Stale server preview' },
			isUnread: false,
		})]);

		expect(store.byId['a']).toMatchObject({
			lastMessage: 'Live background reply',
			lastActivityAt: '2026-02-25T12:00:00.000Z',
			lastReadAt: '2026-02-25T10:00:00.000Z',
			isUnread: true,
		});
	});

	it('upsertFromServer preserves a newer local read receipt while accepting newer activity', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: {
				createdAt: null,
				lastActivityAt: '2026-02-25T10:00:00.000Z',
				lastReadAt: '2026-02-25T10:00:00.000Z',
			},
		})]);
		store.patchLastReadAt('a', '2026-02-25T12:00:00.000Z');

		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: {
				createdAt: null,
				lastActivityAt: '2026-02-25T11:00:00.000Z',
				lastReadAt: '2026-02-25T10:00:00.000Z',
			},
			isUnread: true,
		})]);

		expect(store.byId['a']).toMatchObject({
			lastActivityAt: '2026-02-25T11:00:00.000Z',
			lastReadAt: '2026-02-25T12:00:00.000Z',
			isUnread: false,
		});
	});

	it('ignores preview and read updates older than the current projection', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: {
				createdAt: null,
				lastActivityAt: '2026-02-25T12:00:00.000Z',
				lastReadAt: '2026-02-25T11:00:00.000Z',
			},
			preview: { lastMessage: 'Current preview' },
			isUnread: true,
		})]);

		store.patchPreview('a', 'Older preview', '2026-02-25T10:00:00.000Z');
		store.patchLastReadAt('a', '2026-02-25T09:00:00.000Z');

		expect(store.byId['a']).toMatchObject({
			lastMessage: 'Current preview',
			lastActivityAt: '2026-02-25T12:00:00.000Z',
			lastReadAt: '2026-02-25T11:00:00.000Z',
			isUnread: true,
		});
	});

	it('upsertFromServer clears startup config for all chats now owned by the server', () => {
		const store = new ChatSessionsStore();
		store.createDraft({
			id: 'draft-a',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'A',
			},
		});
		store.createDraft({
			id: 'draft-b',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'B',
			},
		});

		store.upsertFromServer([
			makeServerSession({ id: 'draft-a' }),
			makeServerSession({ id: 'draft-b', title: 'B' }),
		]);

		expect(store.startupByChatId).toEqual({});
	});

	it('patchChat updates arbitrary fields', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a', title: 'Old' })]);
		store.patchChat('a', { title: 'Renamed' });

		expect(store.byId['a']?.title).toBe('Renamed');
	});

	it('reapplying a server entry does not duplicate a running chat', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.applyStartEntry(makeServerSession({ id: 'a' }));

		expect(store.order.filter((id) => id === 'a')).toHaveLength(1);
		expect(store.byId['a']?.status).toBe('running');
	});

	it('draft title falls back to New Session when firstMessage is empty', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'empty-msg',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: '   ',
			},
		});

		expect(store.byId['empty-msg']?.title).toBe('New Session');
	});

	it('hasChat returns true for existing chats', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);

		expect(store.hasChat('a')).toBe(true);
		expect(store.hasChat('nonexistent')).toBe(false);
	});

	it('hasChat returns true for drafts', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		expect(store.hasChat('draft-1')).toBe(true);
	});

	it('isDraft returns true only for draft chats', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});
		store.upsertFromServer([makeServerSession({ id: 'active-1' })]);

		expect(store.isDraft('draft-1')).toBe(true);
		expect(store.isDraft('active-1')).toBe(false);
		expect(store.isDraft('nonexistent')).toBe(false);
	});

	it('isDraft returns false after promotion', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		expect(store.isDraft('draft-1')).toBe(true);

		store.applyStartEntry(makeServerSession({ id: 'draft-1', title: 'Hello' }));

		expect(store.isDraft('draft-1')).toBe(false);
	});

	it('defaults isProcessing to false for server sessions', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);

		expect(store.byId['a']?.isProcessing).toBe(false);
	});

	it('defaults isProcessing to false for drafts', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-1']?.isProcessing).toBe(false);
	});

	it('applyProcessingEvent updates a single chat', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		expect(store.byId['a']?.isProcessing).toBe(false);

		store.applyProcessingEvent('a', true);
		expect(store.byId['a']?.isProcessing).toBe(true);

		store.applyProcessingEvent('a', false);
		expect(store.byId['a']?.isProcessing).toBe(false);
	});

	it('upsertFromServer observes processing changes before a WS baseline exists', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'a', isActive: false })]);

		store.upsertFromServer([makeServerSession({ id: 'a', isActive: true })]);

		expect(store.byId['a']?.isProcessing).toBe(true);
	});

	it('applies an early processing event when an external chat enters the snapshot', () => {
		const store = new ChatSessionsStore();

		store.applyProcessingEvent('scheduled-chat', true);
		const ref = store.byId;

		expect(store.byId).toBe(ref);
		expect(store.isChatProcessing('scheduled-chat')).toBe(true);

		store.upsertFromServer([
			makeServerSession({ id: 'scheduled-chat', title: 'Scheduled chat', isActive: false }),
		]);

		expect(store.byId['scheduled-chat']?.isProcessing).toBe(true);
	});

	it('cancels an early processing event when completion arrives before the snapshot', () => {
		const store = new ChatSessionsStore();

		store.applyProcessingEvent('scheduled-chat', true);
		store.applyProcessingEvent('scheduled-chat', false);
		store.upsertFromServer([makeServerSession({ id: 'scheduled-chat', isActive: false })]);

		expect(store.byId['scheduled-chat']?.isProcessing).toBe(false);
	});

	it('clears an early processing event when its chat is deleted', () => {
		const store = new ChatSessionsStore();

		store.applyProcessingEvent('scheduled-chat', true);
		store.removeChat('scheduled-chat');
		store.upsertFromServer([makeServerSession({ id: 'scheduled-chat', isActive: false })]);

		expect(store.byId['scheduled-chat']?.isProcessing).toBe(false);
	});

	it('applyProcessingEvent is a no-op when value unchanged', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId;

		store.applyProcessingEvent('a', false);

		expect(store.byId).toBe(ref);
	});

	it('reconcileProcessing sets active chats to processing', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({ id: 'a' }),
			makeServerSession({ id: 'b', title: 'B' }),
			makeServerSession({ id: 'c', title: 'C' }),
		]);

		store.reconcileProcessing(new Set(['a', 'c']));

		expect(store.byId['a']?.isProcessing).toBe(true);
		expect(store.byId['b']?.isProcessing).toBe(false);
		expect(store.byId['c']?.isProcessing).toBe(true);
	});

	it('reconcileProcessing clears stale processing flags', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({ id: 'a' }),
			makeServerSession({ id: 'b', title: 'B' }),
		]);
		store.applyProcessingEvent('a', true);
		store.applyProcessingEvent('b', true);

		store.reconcileProcessing(new Set(['b']));

		expect(store.byId['a']?.isProcessing).toBe(false);
		expect(store.byId['b']?.isProcessing).toBe(true);
	});

	it('reconcileProcessing replaces early processing events with its authoritative snapshot', () => {
		const store = new ChatSessionsStore();

		store.applyProcessingEvent('stale-chat', true);
		store.reconcileProcessing(new Set(['active-chat']));
		store.upsertFromServer([
			makeServerSession({ id: 'stale-chat', isActive: false }),
			makeServerSession({ id: 'active-chat', title: 'Active', isActive: false }),
		]);

		expect(store.byId['stale-chat']?.isProcessing).toBe(false);
		expect(store.byId['active-chat']?.isProcessing).toBe(true);
	});

	it('reconcileProcessing does not mutate when nothing changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({ id: 'a' }),
			makeServerSession({ id: 'b', title: 'B' }),
		]);
		store.applyProcessingEvent('a', true);

		const ref = store.byId;
		store.reconcileProcessing(new Set(['a']));

		expect(store.byId).toBe(ref);
	});

	it('upsertFromServer preserves WS-authoritative isProcessing over stale REST snapshot', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.applyProcessingEvent('a', true);

		store.upsertFromServer([makeServerSession({ id: 'a', title: 'Updated' })]);

		expect(store.byId['a']?.isProcessing).toBe(true);
		expect(store.byId['a']?.title).toBe('Updated');
	});

	it('upsertFromServer preserves a terminal WS event over a stale active REST snapshot', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a', isActive: true })]);
		store.applyProcessingEvent('a', false);
		store.upsertFromServer([makeServerSession({ id: 'a', title: 'Updated', isActive: true })]);

		expect(store.byId['a']?.isProcessing).toBe(false);
		expect(store.byId['a']?.title).toBe('Updated');
	});

	it('invalidateProcessingAuthority lets the next REST snapshot converge processing', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'a', isActive: true })]);
		store.reconcileProcessing(new Set(['a']));
		store.applyProcessingEvent('a', true);

		store.invalidateProcessingAuthority();
		store.upsertFromServer([makeServerSession({ id: 'a', isActive: false })]);

		expect(store.byId['a']?.isProcessing).toBe(false);
	});

	it('prunes processing authority for a known chat removed from the server list', () => {
		const store = new ChatSessionsStore();
		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.applyProcessingEvent('a', true);

		store.upsertFromServer([]);
		store.upsertFromServer([makeServerSession({ id: 'a', isActive: false })]);

		expect(store.byId['a']?.isProcessing).toBe(false);
	});

	it('reconnect processing baseline governs chats arriving in later list responses', () => {
		const store = new ChatSessionsStore();

		store.reconcileProcessing(new Set(['active-chat']));
		store.upsertFromServer([
			makeServerSession({ id: 'active-chat', isActive: false }),
			makeServerSession({ id: 'stale-chat', title: 'Stale', isActive: true }),
		]);

		expect(store.byId['active-chat']?.isProcessing).toBe(true);
		expect(store.byId['stale-chat']?.isProcessing).toBe(false);
	});

	it('reconcileProcessing after upsertFromServer correctly sets processing state', () => {
		const store = new ChatSessionsStore();

		// Session list arrives first (correct sequencing).
		store.upsertFromServer([
			makeServerSession({ id: 'a' }),
			makeServerSession({ id: 'b', title: 'B' }),
		]);

		// Active-chats snapshot arrives after.
		store.reconcileProcessing(new Set(['a']));

		expect(store.byId['a']?.isProcessing).toBe(true);
		expect(store.byId['b']?.isProcessing).toBe(false);
	});

	it('patchLastReadAt updates lastReadAt and derives isUnread', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		expect(store.byId['a']?.isUnread).toBe(false);
		expect(store.byId['a']?.lastReadAt).toBeNull();

		store.patchLastReadAt('a', '2026-02-25T12:00:00.000Z');

		expect(store.byId['a']?.lastReadAt).toBe('2026-02-25T12:00:00.000Z');
		expect(store.byId['a']?.isUnread).toBe(false);
	});

	it('patchLastReadAt derives isUnread true when lastActivityAt is newer', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				activity: { createdAt: null, lastActivityAt: '2026-02-25T14:00:00.000Z', lastReadAt: null },
			} as any),
		]);

		store.patchLastReadAt('a', '2026-02-25T12:00:00.000Z');

		expect(store.byId['a']?.lastReadAt).toBe('2026-02-25T12:00:00.000Z');
		expect(store.byId['a']?.isUnread).toBe(true);
	});

	it('patchLastReadAt is no-op when values unchanged', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.patchLastReadAt('a', '2026-02-25T12:00:00.000Z');
		const ref = store.byId;

		store.patchLastReadAt('a', '2026-02-25T12:00:00.000Z');
		expect(store.byId).toBe(ref);
	});

	it('patchLastReadAt is no-op for unknown chat', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId;

		store.patchLastReadAt('nonexistent', '2026-02-25T12:00:00.000Z');
		expect(store.byId).toBe(ref);
	});

	it('toRecord maps lastReadAt and isUnread from server session', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				activity: {
					createdAt: null,
					lastActivityAt: '2026-02-25T13:00:00.000Z',
					lastReadAt: '2026-02-25T10:00:00.000Z',
				},
				isUnread: true,
			} as any),
		]);

		expect(store.byId['a']?.lastReadAt).toBe('2026-02-25T10:00:00.000Z');
		expect(store.byId['a']?.isUnread).toBe(true);
	});

	it('sameRecord detects lastReadAt / isUnread changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		// Upsert with isUnread change.
		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				isUnread: true,
			} as any),
		]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.isUnread).toBe(true);
	});

	it('upsertFromServer preserves read state identity when unchanged', () => {
		const store = new ChatSessionsStore();

		const session = makeServerSession({ id: 'a' });
		store.upsertFromServer([session]);
		const ref = store.byId['a'];

		store.upsertFromServer([session]);
		expect(store.byId['a']).toBe(ref);
	});

	it('sameRecord detects isArchived changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				isArchived: true,
			}),
		]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.isArchived).toBe(true);
	});

	it('createDraft defaults isArchived to false', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-arch',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-arch']?.isArchived).toBe(false);
	});

	it('createDraft defaults lastReadAt to null and isUnread to false', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-1']?.lastReadAt).toBeNull();
		expect(store.byId['draft-1']?.isUnread).toBe(false);
	});

	it('toRecord maps permission, thinking, and integration settings from the server session', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				permissionMode: 'acceptEdits',
				thinkingMode: 'medium',
				agentSettings: {
					ownerId: 'claude',
					schemaVersion: 1,
					values: { thinkingMode: 'off' },
				},
			} as any),
		]);

		expect(store.byId['a']?.permissionMode).toBe('acceptEdits');
		expect(store.byId['a']?.thinkingMode).toBe('medium');
		expect(store.byId['a']?.agentSettings.values.thinkingMode).toBe('off');
	});

	it('toRecord defaults missing integration settings for partial persisted sessions', () => {
		const store = new ChatSessionsStore();

		const partial = makeServerSession({ id: 'a' }) as Partial<ChatSession> & {
			agentSettings?: ChatSession['agentSettings'];
		};
		delete partial.agentSettings;
		store.upsertFromServer([partial as ChatSession]);

		expect(store.byId['a']?.permissionMode).toBe('default');
		expect(store.byId['a']?.thinkingMode).toBe('none');
		expect(store.byId['a']?.agentSettings).toEqual({
			ownerId: 'claude',
			schemaVersion: 1,
			values: {},
		});
	});

	it('toRecord normalizes invalid universal modes and mismatched integration settings', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				permissionMode: 'bogus' as any,
				thinkingMode: 'very-hard' as any,
				agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
			} as any),
		]);

		expect(store.byId['a']?.permissionMode).toBe('default');
		expect(store.byId['a']?.thinkingMode).toBe('none');
		expect(store.byId['a']?.agentSettings.ownerId).toBe('claude');
	});

	it('sameRecord detects permissionMode changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				permissionMode: 'bypassPermissions',
			} as any),
		]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.permissionMode).toBe('bypassPermissions');
	});

	it('sameRecord detects thinkingMode changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([
			makeServerSession({
				id: 'a',
				thinkingMode: 'max',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			} as any),
		]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.thinkingMode).toBe('max');
	});

	it('sameRecord detects integration setting changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.byId = {
			...store.byId,
			a: {
				...store.byId['a']!,
				agentSettings: {
					ownerId: 'claude',
					schemaVersion: 1,
					values: { thinkingMode: 'legacy' },
				},
			},
		};
		const ref = store.byId['a'];

		store.upsertFromServer([makeServerSession({ id: 'a' })]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.agentSettings.values.thinkingMode).toBe('auto');
	});

	it('createDraft maps permissionMode and thinkingMode from startup config', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-modes',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'acceptEdits',
				thinkingMode: 'medium',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-modes']?.permissionMode).toBe('acceptEdits');
		expect(store.byId['draft-modes']?.thinkingMode).toBe('medium');
	});

	it('patchChat updates mode fields', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.patchChat('a', {
			permissionMode: 'bypassPermissions',
			thinkingMode: 'low',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'on' } },
		});

		expect(store.byId['a']?.permissionMode).toBe('bypassPermissions');
		expect(store.byId['a']?.thinkingMode).toBe('low');
		expect(store.byId['a']?.agentSettings.values.thinkingMode).toBe('on');
	});

	it('patchDraftStartup updates startup config for draft chats', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: 'Hello',
			},
		});

		store.patchDraftStartup('draft-1', {
			model: 'sonnet',
			permissionMode: 'acceptEdits',
			thinkingMode: 'medium',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'off' } },
		});

		expect(store.startupByChatId['draft-1']?.model).toBe('sonnet');
		expect(store.startupByChatId['draft-1']?.permissionMode).toBe('acceptEdits');
		expect(store.startupByChatId['draft-1']?.thinkingMode).toBe('medium');
		expect(store.startupByChatId['draft-1']?.agentSettings.values.thinkingMode).toBe('off');
	});

	it('patchDraftStartup is a no-op for non-draft chats', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'active-1' })]);
		const startupRef = store.startupByChatId;

		store.patchDraftStartup('active-1', { model: 'sonnet' });

		expect(store.startupByChatId).toBe(startupRef);
	});
});
