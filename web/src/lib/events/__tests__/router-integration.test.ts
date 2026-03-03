import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import RouterIntegrationHarness from './RouterIntegrationHarness.svelte';
import type { EventRouterStores } from '../router.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';

function createStores(overrides: Partial<EventRouterStores> = {}): EventRouterStores {
	return {
		provider: () => 'claude',
		selectedChat: () => ({ id: 'chat-a', projectPath: '/repo' } as never),
		currentChatId: () => 'chat-a',
		setCurrentChatId: vi.fn(),
		chatMessages: () => [],
		setChatMessages: vi.fn(),
		loadMessages: vi.fn().mockResolvedValue([]),
		setIsLoading: vi.fn(),
		setCanAbort: vi.fn(),
		setLoadingStatus: vi.fn(),
		pushLoadingStatus: vi.fn(),
		popLoadingStatus: vi.fn(),
		setIsSystemChatChange: vi.fn(),
		pendingPermissionRequests: () => [],
		setPendingPermissionRequests: vi.fn(),
		pendingViewChat: () => null,
		setPendingViewChat: vi.fn(),
		setMessageQueue: vi.fn(),
		permissionMode: () => 'default',
		previousPermissionMode: () => null,
		setPermissionMode: vi.fn(),
		setPreviousPermissionMode: vi.fn(),
		patchChatPreview: vi.fn(),
		refreshChats: vi.fn(),
		hasChat: () => true,
		navigateToChat: vi.fn(),
		removeChat: vi.fn(),
		patchChatTitle: vi.fn(),
		navigateAwayFromChat: vi.fn(),
		startupCoordinator: {} as never,
		onLocalStartupConfirmed: vi.fn(),
		onExternalChatCreated: vi.fn(),
		reconcileProcessing: vi.fn(),
		setChatProcessing: vi.fn(),
		patchLastReadAt: vi.fn(),
		enqueueReadReceipt: vi.fn(),
		...overrides,
	};
}

function renderRouterWithRawMessages(
	rawMessages: Array<Record<string, unknown>>,
	stores: EventRouterStores,
) {
	const connection = { messageVersion: 1 } as WsConnection;
	let drained = false;
	const drainHandle: DrainHandle = {
		drain: () => {
			if (drained) return [];
			drained = true;
			return rawMessages.map((data) => ({ data, timestamp: Date.now() }));
		},
		cleanup: vi.fn(),
	};

	render(RouterIntegrationHarness, { connection, drainHandle, stores });
}

describe('event router integration', () => {
	it('routes a global event from raw payload through normalize + filter + handler', () => {
		const stores = createStores();
		renderRouterWithRawMessages([
			{ type: 'chat-list-refresh-requested', reason: 'archive-toggled', chatId: 'chat-b' },
		], stores);

		expect(stores.refreshChats).toHaveBeenCalledTimes(1);
	});

	it('drops malformed payloads before reaching handlers', () => {
		const stores = createStores();
		renderRouterWithRawMessages([
			{ type: 'chat-list-refresh-requested', reason: 'archive-toggled' },
		], stores);

		expect(stores.refreshChats).not.toHaveBeenCalled();
	});

	it('skips scoped lifecycle events for non-active chats', () => {
		const stores = createStores();
		renderRouterWithRawMessages([
			{ type: 'agent-run-finished', chatId: 'chat-b', exitCode: 0 },
		], stores);

		expect(stores.setIsLoading).not.toHaveBeenCalled();
		expect(stores.setCanAbort).not.toHaveBeenCalled();
	});
});
