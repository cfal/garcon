import { expect, test, vi } from 'vitest';
import { WorkspaceChatPlacementService } from '../workspace-chat-placement';
import { canonicalWorkspaceSnapshot, CANONICAL_CHAT_SURFACE_ID } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { chatViewSurfaceId, type WorkspaceWindowId } from '../surface-types';

test('reuses a chat in another window while the anchor is reserved', async () => {
	const initial = canonicalWorkspaceSnapshot();
	const snapshot = {
		...initial,
		surfaces: {
			...initial.surfaces,
			[CANONICAL_CHAT_SURFACE_ID]: {
				id: CANONICAL_CHAT_SURFACE_ID,
				type: 'chat' as const,
				chatId: '1780000000000001',
			},
		},
	};
	const deps = {
		surfaceReservations: new Set<string>(),
		windowReservations: new Set(['window-files']),
		isMobile: () => false,
		lastFocusedWindowId: () => 'window-files' as const,
		resolveWindowId: (_snapshot, preferred) => preferred ?? 'window-main',
		commit: async () => {
			throw new Error('Reuse must not clear a chat');
		},
		commitWithPresentationTarget: async (plan) => {
			if (typeof plan === 'function') await plan(snapshot);
			return true;
		},
		prepareChatSurfaceTransfer: () => {
			throw new Error('Reuse must not move a chat');
		},
		resolveSplitAdmission: () => {
			throw new Error('Reuse must not split a window');
		},
		windowsFitHost: () => {
			throw new Error('Reuse must not measure a layout');
		},
		present: () => {},
	} satisfies ConstructorParameters<typeof WorkspaceChatPlacementService>[0];
	const service = new WorkspaceChatPlacementService(deps);
	await expect(service.openBeside('1780000000000001', 'window-files')).resolves.toBe('window-main');
});

test.each([
	{ windowId: 'window-main', kind: 'window' },
	{ windowId: 'window-files', kind: 'window' },
	{ windowId: 'window-main', kind: 'surface' },
	{ windowId: 'window-files', kind: 'surface' },
] as const)(
	'checks the $kind reservation in $windowId before preparing either swap transfer',
	async ({ windowId, kind }) => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-window-chat', windowId: 'window-main', chatId: 'chat-a' },
			{ type: 'set-window-chat', windowId: 'window-files', chatId: 'chat-b' },
		]);
		const prepareChatSurfaceTransfer = vi.fn(() => null);
		const present = vi.fn();
		const deps = {
			surfaceReservations: new Set(kind === 'surface' ? [chatViewSurfaceId(windowId)] : []),
			windowReservations: new Set<WorkspaceWindowId>(kind === 'window' ? [windowId] : []),
			isMobile: () => false,
			lastFocusedWindowId: () => 'window-files' as const,
			resolveWindowId: (_snapshot, preferred) => preferred ?? 'window-main',
			commit: async () => {
				throw new Error('Unexpected commit');
			},
			commitWithPresentationTarget: async (plan, _target, options) => {
				if (typeof plan === 'function') plan(snapshot);
				options?.publication?.publish();
				return true;
			},
			prepareChatSurfaceTransfer,
			resolveSplitAdmission: () => {
				throw new Error('Unexpected split');
			},
			windowsFitHost: () => {
				throw new Error('Unexpected measurement');
			},
			present,
		} satisfies ConstructorParameters<typeof WorkspaceChatPlacementService>[0];
		const swapping = new WorkspaceChatPlacementService(deps).swapIntoWindow(
			'chat-a',
			'window-files',
			'chat-b',
		);
		if (windowId === 'window-main') await expect(swapping).rejects.toThrow('Failed to open view');
		else {
			await expect(swapping).resolves.toBe(CANONICAL_CHAT_SURFACE_ID);
			expect(present).toHaveBeenCalledWith(CANONICAL_CHAT_SURFACE_ID);
		}
		expect(prepareChatSurfaceTransfer).not.toHaveBeenCalled();
	},
);
