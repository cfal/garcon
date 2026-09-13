import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import {
	TranscriptNavigationController,
	type TranscriptNavigationDeps,
} from '$lib/chat/actions/transcript-navigation-controller.js';
import type { TranscriptRowNavigationResult } from '$lib/chat/transcript/transcript-row-navigation.js';
import type { FocusOwner } from '$lib/workspace/surface-types.js';
import {
	SearchResultNavigationController,
	type SearchResultNavigationDeps,
} from '../search-result-navigation-controller.js';

const target = { chatId: '1000000000000001', transcriptViewId: 'original-view', ordinal: 4 };
const surfaceId = 'chat-view:window-one' as const;
function held<T>() {
	let release!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function fixture() {
	const panel = {
		chatId: target.chatId,
		navigateToTranscriptRow: vi.fn<ConversationPanelRegistration['navigateToTranscriptRow']>(
			async () => 'completed',
		),
	} satisfies Pick<ConversationPanelRegistration, 'chatId' | 'navigateToTranscriptRow'>;
	const workspace = {
		layout: { surface: () => ({ id: surfaceId, type: 'chat' as const, chatId: panel.chatId }) },
		lastFocusedSurfaceId: 'singleton:tickets',
		focusOwnerRevision: 1,
		focusOwner: { kind: 'surface', surfaceId: 'singleton:tickets' } as FocusOwner,
		showChatInWindow: vi.fn(async (chatId: string) => {
			panel.chatId = chatId;
			workspace.lastFocusedSurfaceId = surfaceId;
			workspace.focusOwner = { kind: 'surface', surfaceId };
			workspace.focusOwnerRevision++;
			return surfaceId;
		}),
		showChatInCurrentWindow: vi.fn(async (chatId: string): Promise<typeof surfaceId> =>
			workspace.showChatInWindow(chatId),
		),
	} satisfies TranscriptNavigationDeps['workspace'];
	const navigation = new TranscriptNavigationController({
		workspace,
		panels: { panel: () => panel },
		hasChat: () => true,
		authority: () => 'authority',
	});
	const deps = {
		navigation,
		notifications: { info: vi.fn(), error: vi.fn() },
		discardStaleResult: vi.fn(),
		validate: vi.fn<NonNullable<SearchResultNavigationDeps['validate']>>(async (request) => ({
			chatId: request.chatId,
			ordinal: request.ordinal,
		})),
	} satisfies SearchResultNavigationDeps;
	const controller = new SearchResultNavigationController(deps);
	return {
		deps,
		navigation,
		controller,
		workspace,
		panel,
		open: () => controller.open({ chatId: target.chatId, target }, 'window-one'),
		loseFocus: () => {
			workspace.focusOwner = { kind: 'chat-list' };
			workspace.focusOwnerRevision++;
			navigation.reconcile();
		},
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it('navigates the returned panel with the original full row address', async () => {
	const f = fixture();
	await f.open();
	expect(f.deps.validate).toHaveBeenCalledWith(target, { signal: expect.any(AbortSignal) });
	expect(f.workspace.showChatInWindow).toHaveBeenCalledWith(target.chatId, 'window-one');
	expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledWith(
		target,
		expect.any(AbortSignal),
		expect.any(Function),
	);
	expect(f.deps.notifications.error).not.toHaveBeenCalled();
});

it('uses current-window placement on mobile', async () => {
	const f = fixture();
	await f.controller.open({ chatId: target.chatId, target }, 'mobile');
	expect(f.workspace.showChatInCurrentWindow).toHaveBeenCalledWith(target.chatId);
});

it('opens metadata-only matches without validation or a row jump', async () => {
	const f = fixture();
	await f.controller.open({ chatId: target.chatId, target: null }, 'window-one');
	expect(f.workspace.showChatInWindow).toHaveBeenCalledOnce();
	expect(f.deps.validate).not.toHaveBeenCalled();
	expect(f.panel.navigateToTranscriptRow).not.toHaveBeenCalled();
});

it('opens a stale result at chat level and refreshes its original view only', async () => {
	const f = fixture();
	f.deps.validate.mockRejectedValue(new ApiError(409, 'stale', 'SEARCH_RESULT_STALE'));
	await f.open();
	expect(f.workspace.showChatInWindow).toHaveBeenCalledOnce();
	expect(f.panel.navigateToTranscriptRow).not.toHaveBeenCalled();
	expect(f.deps.discardStaleResult).toHaveBeenCalledWith(target);
	expect(f.deps.notifications.info).toHaveBeenCalledWith(
		'Transcript was reloaded; search results refreshed.',
	);
});

it.each(['view-changed', 'unavailable', 'cancelled'] as const)(
	'handles %s from the target page without remapping',
	async (result) => {
		const f = fixture();
		f.panel.navigateToTranscriptRow.mockResolvedValue(result);
		await f.open();
		expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledOnce();
		expect(f.deps.discardStaleResult).toHaveBeenCalledTimes(result === 'view-changed' ? 1 : 0);
		expect(f.deps.notifications.info).toHaveBeenCalledTimes(result === 'cancelled' ? 0 : 1);
		if (result === 'unavailable')
			expect(f.deps.notifications.info).toHaveBeenCalledWith(
				'Matching row is hidden or no longer available.',
			);
	},
);

it('newer selections supersede validation even when its transport ignores abort', async () => {
	const f = fixture();
	const read = held<{ chatId: string; ordinal: number }>();
	f.deps.validate.mockReturnValueOnce(read.promise);
	const first = f.open();
	await f.controller.open({ chatId: '1000000000000002', target: null }, 'window-one');
	read.release({ chatId: target.chatId, ordinal: target.ordinal });
	await first;
	expect(f.deps.validate.mock.calls[0]![1]!.signal!.aborted).toBe(true);
	expect(f.workspace.showChatInWindow).toHaveBeenCalledExactlyOnceWith(
		'1000000000000002',
		'window-one',
	);
	expect(f.panel.navigateToTranscriptRow).not.toHaveBeenCalled();
});

it('cancels on focus loss during validation without late placement', async () => {
	const f = fixture();
	const read = held<{ chatId: string; ordinal: number }>();
	f.deps.validate.mockReturnValueOnce(read.promise);
	const work = f.open();
	f.loseFocus();
	read.release({ chatId: target.chatId, ordinal: 4 });
	await work;
	expect(f.workspace.showChatInWindow).not.toHaveBeenCalled();
});

it('cancels a held target page and suppresses stale-result feedback after focus loss', async () => {
	const f = fixture();
	const page = held<TranscriptRowNavigationResult>();
	f.panel.navigateToTranscriptRow.mockReturnValue(page.promise);
	const work = f.open();
	await vi.waitFor(() => expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledOnce());
	const [, signal, current] = f.panel.navigateToTranscriptRow.mock.calls[0]!;
	f.loseFocus();
	expect(signal.aborted).toBe(true);
	expect(current()).toBe(false);
	page.release('view-changed');
	await work;
	expect(f.deps.discardStaleResult).not.toHaveBeenCalled();
	expect(f.deps.notifications.info).not.toHaveBeenCalled();
});

it('captures the target before awaiting validation', async () => {
	const f = fixture();
	const mutable = { ...target };
	const read = held<{ chatId: string; ordinal: number }>();
	f.deps.validate.mockReturnValue(read.promise);
	const work = f.controller.open({ chatId: target.chatId, target: mutable }, 'window-one');
	mutable.transcriptViewId = 'replacement';
	mutable.ordinal = 99;
	read.release({ chatId: target.chatId, ordinal: 4 });
	await work;
	expect(f.panel.navigateToTranscriptRow.mock.calls[0]![0]).toEqual(target);
});

it.each([
	{ chatId: 'other-chat', ordinal: 4 },
	{ chatId: target.chatId, ordinal: 99 },
])('rejects a mismatched validation response %j', async (response) => {
	const f = fixture();
	f.deps.validate.mockResolvedValue(response);
	await f.open();
	expect(f.workspace.showChatInWindow).not.toHaveBeenCalled();
	expect(f.deps.notifications.error).toHaveBeenCalledOnce();
});

it.each(['deleted', 'network'] as const)(
	'reports %s without treating it as a replaced view',
	async (kind) => {
		const f = fixture();
		f.deps.validate.mockRejectedValue(
			kind === 'deleted' ? new ApiError(404, 'missing', 'SESSION_NOT_FOUND') : new Error('network'),
		);
		await f.open();
		expect(f.deps.notifications.error).toHaveBeenCalledWith(
			kind === 'deleted'
				? 'Search result chat is no longer available.'
				: 'Could not open search result. Try again.',
		);
		expect(f.deps.discardStaleResult).not.toHaveBeenCalled();
	},
);

it('expires a held validation once and never installs the late target', async () => {
	vi.useFakeTimers();
	const f = fixture();
	const read = held<{ chatId: string; ordinal: number }>();
	f.deps.validate.mockReturnValue(read.promise);
	const work = f.open();
	await vi.advanceTimersByTimeAsync(30_000);
	expect(f.deps.notifications.error).toHaveBeenCalledExactlyOnceWith(
		'Could not open search result. Try again.',
	);
	read.release({ chatId: target.chatId, ordinal: 4 });
	await work;
	expect(f.workspace.showChatInWindow).not.toHaveBeenCalled();
});
