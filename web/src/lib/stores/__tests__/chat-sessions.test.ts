import { describe, it, expect } from 'vitest';
import { ChatSessionsStore } from '../chat-sessions.svelte';
import type { ChatSession } from '$lib/types/session';

function makeServerSession(overrides: Partial<ChatSession> = {}): ChatSession {
	return {
		id: 'a',
		provider: 'claude',
		model: 'opus',
		title: 'A',
		projectPath: '/p',
		tags: [],
		native: { path: null },
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isUnread: false,
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

	it('creates and promotes draft', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-1']?.status).toBe('draft');
		expect(store.byId['draft-1']?.title).toBe('Hello');
		expect(store.startupByChatId['draft-1']).toBeTruthy();
		expect(store.selectedChatId).toBe('draft-1');
		expect(store.order[0]).toBe('draft-1');

		store.promoteDraft('draft-1');

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

	it('removeChat clears byId, order, startup, and deselects', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
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
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
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
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
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

	it('patchChat updates arbitrary fields', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a', title: 'Old' })]);
		store.patchChat('a', { title: 'Renamed' });

		expect(store.byId['a']?.title).toBe('Renamed');
	});

	it('promoteDraft is a no-op for non-draft chats', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.promoteDraft('a');

		// Should be same reference since it was already running.
		expect(store.byId['a']).toBe(ref);
	});

	it('draft title falls back to New Session when firstMessage is empty', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'empty-msg',
			projectPath: '/repo',
			startup: {
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
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
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
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
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
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
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				firstMessage: 'Hello',
			},
		});

		expect(store.isDraft('draft-1')).toBe(true);

		store.promoteDraft('draft-1');

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
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-1']?.isProcessing).toBe(false);
	});

	it('setChatProcessing updates a single chat', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		expect(store.byId['a']?.isProcessing).toBe(false);

		store.setChatProcessing('a', true);
		expect(store.byId['a']?.isProcessing).toBe(true);

		store.setChatProcessing('a', false);
		expect(store.byId['a']?.isProcessing).toBe(false);
	});

	it('setChatProcessing is a no-op for unknown chats', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId;

		store.setChatProcessing('nonexistent', true);

		expect(store.byId).toBe(ref);
	});

	it('setChatProcessing is a no-op when value unchanged', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId;

		store.setChatProcessing('a', false);

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
		store.setChatProcessing('a', true);
		store.setChatProcessing('b', true);

		store.reconcileProcessing(new Set(['b']));

		expect(store.byId['a']?.isProcessing).toBe(false);
		expect(store.byId['b']?.isProcessing).toBe(true);
	});

	it('reconcileProcessing does not mutate when nothing changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({ id: 'a' }),
			makeServerSession({ id: 'b', title: 'B' }),
		]);
		store.setChatProcessing('a', true);

		const ref = store.byId;
		store.reconcileProcessing(new Set(['a']));

		expect(store.byId).toBe(ref);
	});

	it('upsertFromServer resets isProcessing from server isActive snapshot', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.setChatProcessing('a', true);

		store.upsertFromServer([makeServerSession({ id: 'a', title: 'Updated' })]);

		expect(store.byId['a']?.isProcessing).toBe(false);
		expect(store.byId['a']?.title).toBe('Updated');
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

		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: { createdAt: null, lastActivityAt: '2026-02-25T14:00:00.000Z', lastReadAt: null },
		} as any)]);

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

		store.upsertFromServer([makeServerSession({
			id: 'a',
			activity: { createdAt: null, lastActivityAt: '2026-02-25T13:00:00.000Z', lastReadAt: '2026-02-25T10:00:00.000Z' },
			isUnread: true,
		} as any)]);

		expect(store.byId['a']?.lastReadAt).toBe('2026-02-25T10:00:00.000Z');
		expect(store.byId['a']?.isUnread).toBe(true);
	});

	it('sameRecord detects lastReadAt / isUnread changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		// Upsert with isUnread change.
		store.upsertFromServer([makeServerSession({
			id: 'a',
			isUnread: true,
		} as any)]);

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

		store.upsertFromServer([makeServerSession({
			id: 'a',
			isArchived: true,
		})]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.isArchived).toBe(true);
	});

	it('createDraft defaults isArchived to false', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-arch',
			projectPath: '/repo',
			startup: {
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
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
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-1']?.lastReadAt).toBeNull();
		expect(store.byId['draft-1']?.isUnread).toBe(false);
	});

	it('toRecord maps permissionMode and thinkingMode from server session', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({
			id: 'a',
			permissionMode: 'acceptEdits',
			thinkingMode: 'think-hard',
		} as any)]);

		expect(store.byId['a']?.permissionMode).toBe('acceptEdits');
		expect(store.byId['a']?.thinkingMode).toBe('think-hard');
	});

	it('toRecord defaults permissionMode and thinkingMode for legacy sessions', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);

		expect(store.byId['a']?.permissionMode).toBe('default');
		expect(store.byId['a']?.thinkingMode).toBe('none');
	});

	it('sameRecord detects permissionMode changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([makeServerSession({
			id: 'a',
			permissionMode: 'bypassPermissions',
		} as any)]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.permissionMode).toBe('bypassPermissions');
	});

	it('sameRecord detects thinkingMode changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([makeServerSession({
			id: 'a',
			thinkingMode: 'ultrathink',
		} as any)]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.thinkingMode).toBe('ultrathink');
	});

	it('createDraft maps permissionMode and thinkingMode from startup config', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-modes',
			projectPath: '/repo',
			startup: {
				provider: 'claude',
				model: 'opus',
				permissionMode: 'acceptEdits',
				thinkingMode: 'think-hard',
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-modes']?.permissionMode).toBe('acceptEdits');
		expect(store.byId['draft-modes']?.thinkingMode).toBe('think-hard');
	});

	it('patchChat updates mode fields', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		store.patchChat('a', { permissionMode: 'bypassPermissions', thinkingMode: 'think' });

		expect(store.byId['a']?.permissionMode).toBe('bypassPermissions');
		expect(store.byId['a']?.thinkingMode).toBe('think');
	});

	it('patchDraftStartup updates startup config for draft chats', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-1',
			projectPath: '/repo',
			startup: {
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				firstMessage: 'Hello',
			},
		});

		store.patchDraftStartup('draft-1', {
			model: 'sonnet',
			permissionMode: 'acceptEdits',
			thinkingMode: 'think-hard',
		});

		expect(store.startupByChatId['draft-1']?.model).toBe('sonnet');
		expect(store.startupByChatId['draft-1']?.permissionMode).toBe('acceptEdits');
		expect(store.startupByChatId['draft-1']?.thinkingMode).toBe('think-hard');
	});

	it('patchDraftStartup is a no-op for non-draft chats', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'active-1' })]);
		const startupRef = store.startupByChatId;

		store.patchDraftStartup('active-1', { model: 'sonnet' });

		expect(store.startupByChatId).toBe(startupRef);
	});

	it('maps canFork from server session', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([
			makeServerSession({ id: 'a', canFork: true } as any),
		]);

		expect(store.byId['a']?.canFork).toBe(true);
	});

	it('defaults canFork to false when not provided', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);

		expect(store.byId['a']?.canFork).toBe(false);
	});

	it('createDraft defaults canFork to false', () => {
		const store = new ChatSessionsStore();

		store.createDraft({
			id: 'draft-fork',
			projectPath: '/repo',
			startup: {
				provider: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				firstMessage: 'Hello',
			},
		});

		expect(store.byId['draft-fork']?.canFork).toBe(false);
	});

	it('sameRecord detects canFork changes', () => {
		const store = new ChatSessionsStore();

		store.upsertFromServer([makeServerSession({ id: 'a' })]);
		const ref = store.byId['a'];

		store.upsertFromServer([makeServerSession({
			id: 'a',
			canFork: true,
		} as any)]);

		expect(store.byId['a']).not.toBe(ref);
		expect(store.byId['a']?.canFork).toBe(true);
	});
});
