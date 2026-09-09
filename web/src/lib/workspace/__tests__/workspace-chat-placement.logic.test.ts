import { expect, test } from 'vitest';
import { WorkspaceChatPlacementService } from '../workspace-chat-placement';
import { canonicalWorkspaceSnapshot, CANONICAL_CHAT_SURFACE_ID } from '../canonical-layout';

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
		present: () => {},
	} satisfies ConstructorParameters<typeof WorkspaceChatPlacementService>[0];
	const service = new WorkspaceChatPlacementService(deps);
	await expect(service.openBeside('1780000000000001', 'window-files')).resolves.toBe('window-main');
});
