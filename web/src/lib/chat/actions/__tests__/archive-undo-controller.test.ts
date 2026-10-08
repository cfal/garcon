import { describe, expect, it, vi } from 'vitest';
import { ArchiveUndoController } from '../archive-undo-controller.js';
import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';

function fixture() {
	const sessions = new ChatSessionsStore();
	const notifications = new NotificationsStore();
	const archive = vi.spyOn(sessions, 'startArchivingChats');
	const restore = vi
		.spyOn(sessions, 'startUnarchivingChats')
		.mockReturnValue({ chatIds: ['one'], completion: Promise.resolve() });
	const controller = new ArchiveUndoController(sessions, notifications);
	return { sessions, notifications, archive, restore, controller };
}

describe('archive Undo', () => {
	it('invalidates Undo after an observed restore and later archive', async () => {
		const f = fixture();
		f.sessions.createDraft({ id: 'one', projectPath: '/synthetic', startup: { agentId: 'claude', model: 'opus', firstMessage: 'Synthetic', permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} } } });
		f.sessions.patchChat('one', { isArchived: true });
		f.archive.mockReturnValue({ chatIds: ['one'], completion: Promise.resolve() });
		f.controller.startArchivingChats(['one']);
		await Promise.resolve();
		const oldUndo = f.notifications.items[0]!.action!;
		f.sessions.patchChat('one', { isArchived: false }); f.controller.reconcile();
		f.sessions.patchChat('one', { isArchived: true }); f.controller.reconcile();
		oldUndo.onClick();
		expect(f.restore).not.toHaveBeenCalled();
		expect(f.notifications.items).toHaveLength(0);
	});
	it('waits for success and restores only eligible captured chats once without selecting them', async () => {
		const f = fixture();
		let resolve!: () => void;
		f.archive.mockReturnValue({
			chatIds: ['one', 'two'],
			completion: new Promise<void>((r) => {
				resolve = r;
			}),
		});
		f.controller.startArchivingChats(['one', 'two']);
		expect(f.notifications.items).toHaveLength(0);
		f.sessions.createDraft({
			id: 'one',
			projectPath: '/synthetic',
			startup: {
				agentId: 'claude',
				model: 'opus',
				firstMessage: 'Synthetic',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			},
		});
		f.sessions.patchChat('one', { isArchived: true });
		f.sessions.setSelectedChatId('different');
		resolve();
		await Promise.resolve();
		const undo = f.notifications.items[0]!.action!;
		undo.onClick();
		undo.onClick();
		expect(f.restore).toHaveBeenCalledExactlyOnceWith(['one']);
		expect(f.sessions.selectedChatId).toBe('different');
	});
	it('never offers Undo for unconfirmed failures or obsolete archive completions', async () => {
		const f = fixture();
		f.archive.mockReturnValueOnce({
			chatIds: ['one'],
			completion: Promise.reject(new Error('offline')),
		});
		f.controller.startArchivingChats(['one']);
		await Promise.resolve();
		expect(f.notifications.items).toHaveLength(0);
		let resolve!: () => void;
		f.archive.mockReturnValueOnce({
			chatIds: ['one'],
			completion: new Promise<void>((r) => {
				resolve = r;
			}),
		});
		f.controller.startArchivingChats(['one']);
		f.controller.destroy();
		resolve();
		await Promise.resolve();
		expect(f.notifications.items).toHaveLength(0);
	});
});
