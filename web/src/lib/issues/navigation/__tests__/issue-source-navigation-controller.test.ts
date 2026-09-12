import { afterEach, expect, it, vi } from 'vitest';
import {
	IssueSourceNavigationController,
	type IssueSourceNavigationDeps,
} from '../issue-source-navigation-controller.js';
import type { IssueSourceResolution } from '$shared/issue-source-navigation';
import type { IssueBootstrap } from '$shared/issues';
import { ApiError } from '$lib/api/client.js';
import type { FocusOwner } from '$lib/workspace/surface-types.js';

const source = {
	chatId: '1000000000000001',
	transcriptViewId: '11111111-1111-4111-8111-111111111111',
	ordinal: 7,
};
const target = { ...source, ordinal: 11 };
const surfaceId = 'chat-view:window-one' as const;
function held<T>() {
	let release!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function fixture() {
	let authority: string | null = 'synthetic-auth';
	let partition: Pick<IssueBootstrap, 'storeId' | 'viewerKey'> | null = {
		storeId: 'store-1',
		viewerKey: 'viewer-1',
	};
	let exists = true;
	const panel = {
		chatId: source.chatId,
		navigateToTranscriptRow: vi.fn<
			NonNullable<
				ReturnType<IssueSourceNavigationDeps['panels']['panel']>
			>['navigateToTranscriptRow']
		>(async () => 'completed'),
	};
	const deps = {
		workspace: {
			layout: {
				surface: (id: string) =>
					id === surfaceId ? { id: surfaceId, type: 'chat' as const, chatId: source.chatId } : null,
			},
			lastFocusedSurfaceId: 'singleton:issues',
			focusOwnerRevision: 1,
			focusOwner: { kind: 'surface', surfaceId: 'singleton:issues' } as FocusOwner,
			showChatInWindow: vi.fn(async () => {
				deps.workspace.lastFocusedSurfaceId = surfaceId;
				deps.workspace.focusOwner = { kind: 'surface', surfaceId };
				deps.workspace.focusOwnerRevision++;
				return surfaceId;
			}),
			showChatInCurrentWindow: vi.fn(async () => {
				deps.workspace.lastFocusedSurfaceId = surfaceId;
				deps.workspace.focusOwner = { kind: 'surface', surfaceId };
				deps.workspace.focusOwnerRevision++;
				return surfaceId;
			}),
		},
		panels: { panel: vi.fn(() => panel) },
		hasChat: () => exists,
		authority: () => authority,
		notifications: { info: vi.fn(), error: vi.fn() },
		resolve: vi.fn<NonNullable<IssueSourceNavigationDeps['resolve']>>(async () => ({
			kind: 'found',
			target,
		})),
	} satisfies IssueSourceNavigationDeps;
	const navigator = new IssueSourceNavigationController(deps);
	return {
		deps,
		panel,
		navigator,
		open: () => navigator.open(source, 'window-one', () => partition),
		setAuthority: (value: string | null) => {
			authority = value;
			navigator.reconcile();
		},
		setPartition: (value: typeof partition) => {
			partition = value;
		},
		remove: () => {
			exists = false;
			navigator.reconcile();
		},
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it('opens the exact placed panel and passes the resolved view-qualified notice address', async () => {
	const f = fixture();
	await f.open();
	expect(f.deps.workspace.showChatInWindow).toHaveBeenCalledWith(source.chatId, 'window-one');
	expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledWith(
		target,
		expect.any(AbortSignal),
		expect.any(Function),
	);
	expect(f.deps.notifications.info).not.toHaveBeenCalled();
});

it.each(['transcript-reloaded', 'outcome-unavailable'] as const)(
	'opens only the chat for %s',
	async (kind) => {
		const f = fixture();
		f.deps.resolve.mockResolvedValue({ kind, chatId: source.chatId });
		await f.open();
		expect(f.deps.workspace.showChatInWindow).toHaveBeenCalledOnce();
		expect(f.panel.navigateToTranscriptRow).not.toHaveBeenCalled();
		expect(f.deps.notifications.info).toHaveBeenCalledWith(
			kind === 'transcript-reloaded'
				? 'Transcript was reloaded; exact row unavailable.'
				: 'Exact source row unavailable.',
		);
	},
);

it.each(['view-changed', 'unavailable'] as const)(
	'reports %s during target loading without retargeting',
	async (result) => {
		const f = fixture();
		f.panel.navigateToTranscriptRow.mockResolvedValue(result);
		await f.open();
		expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledOnce();
		expect(f.deps.notifications.info).toHaveBeenCalledOnce();
	},
);

it('newer clicks supersede held source lookups, even if abort is ignored', async () => {
	const f = fixture();
	const first = held<IssueSourceResolution>();
	f.deps.resolve.mockReturnValueOnce(first.promise);
	const earlier = f.open();
	await f.open();
	first.release({ kind: 'found', target });
	await earlier;
	expect(f.deps.resolve.mock.calls[0]![1].aborted).toBe(true);
	expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledOnce();
	expect(f.deps.workspace.showChatInWindow).toHaveBeenCalledOnce();
});

it.each(['authority', 'partition', 'focus', 'deleted'] as const)(
	'does not navigate after %s changes during lookup',
	async (change) => {
		const f = fixture();
		const read = held<IssueSourceResolution>();
		f.deps.resolve.mockReturnValueOnce(read.promise);
		const work = f.open();
		if (change === 'authority') f.setAuthority('new-auth');
		if (change === 'partition') f.setPartition({ storeId: 'store-2', viewerKey: 'viewer-1' });
		if (change === 'focus') {
			f.deps.workspace.focusOwnerRevision++;
			f.navigator.reconcile();
		}
		if (change === 'deleted') f.remove();
		read.release({ kind: 'found', target });
		await work;
		expect(f.deps.workspace.showChatInWindow).not.toHaveBeenCalled();
		expect(f.deps.notifications.info).not.toHaveBeenCalled();
	},
);

it('fences held page installation and notifications after focus ownership changes', async () => {
	const f = fixture();
	const loading = held<'view-changed'>();
	f.panel.navigateToTranscriptRow.mockReturnValue(loading.promise);
	const work = f.open();
	await vi.waitFor(() => expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledOnce());
	const [, signal, current] = f.panel.navigateToTranscriptRow.mock.calls[0]!;
	f.deps.workspace.focusOwner = { kind: 'chat-list' };
	f.deps.workspace.focusOwnerRevision++;
	f.navigator.reconcile();
	expect(signal.aborted).toBe(true);
	expect(current()).toBe(false);
	loading.release('view-changed');
	await work;
	expect(f.deps.notifications.info).not.toHaveBeenCalled();
});

it('keeps deletion races and transport failures separate from transcript reloads', async () => {
	const f = fixture();
	f.deps.resolve.mockRejectedValueOnce(new ApiError(404, 'Missing', 'SESSION_NOT_FOUND'));
	await f.open();
	expect(f.deps.notifications.error).toHaveBeenLastCalledWith(
		'Source chat is no longer available.',
	);
	f.deps.resolve.mockRejectedValueOnce(new ApiError(503, 'Storage unavailable'));
	await f.open();
	expect(f.deps.notifications.error).toHaveBeenLastCalledWith(
		'Could not open issue source. Try again.',
	);
	expect(f.deps.notifications.info).not.toHaveBeenCalled();
	expect(f.deps.workspace.showChatInWindow).not.toHaveBeenCalled();
});

it('allows delayed composer focus on the target surface during page loading', async () => {
	const f = fixture();
	const loading = held<'completed'>();
	f.panel.navigateToTranscriptRow.mockReturnValue(loading.promise);
	const work = f.open();
	await vi.waitFor(() => expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledOnce());
	const [, signal, current] = f.panel.navigateToTranscriptRow.mock.calls[0]!;
	f.deps.workspace.focusOwner = { kind: 'surface', surfaceId };
	f.deps.workspace.focusOwnerRevision++;
	f.navigator.reconcile();
	expect(signal.aborted).toBe(false);
	expect(current()).toBe(true);
	loading.release('completed');
	await work;
	expect(f.deps.notifications.error).not.toHaveBeenCalled();
});

it('does not report an error for a panel-local cancellation', async () => {
	const f = fixture();
	f.panel.navigateToTranscriptRow.mockRejectedValue(
		new DOMException('Navigation cancelled', 'AbortError'),
	);
	await f.open();
	expect(f.deps.notifications.error).not.toHaveBeenCalled();
	expect(f.deps.notifications.info).not.toHaveBeenCalled();
});

it('retains only the published destination focus while placement settlement is held', async () => {
	const f = fixture();
	const placement = held<typeof surfaceId>();
	f.deps.workspace.showChatInWindow.mockImplementation(async () => {
		f.deps.workspace.focusOwner = { kind: 'surface', surfaceId };
		f.deps.workspace.lastFocusedSurfaceId = surfaceId;
		f.deps.workspace.focusOwnerRevision++;
		return placement.promise;
	});
	const work = f.open();
	await vi.waitFor(() => expect(f.deps.workspace.showChatInWindow).toHaveBeenCalledOnce());
	f.navigator.reconcile();
	const signal = f.deps.resolve.mock.calls[0]![1];
	expect(signal.aborted).toBe(false);
	f.deps.workspace.focusOwner = {
		kind: 'window-chrome',
		windowId: 'window-two',
		surfaceId: 'singleton:files',
	};
	f.deps.workspace.lastFocusedSurfaceId = 'singleton:files';
	f.deps.workspace.focusOwnerRevision++;
	f.navigator.reconcile();
	expect(signal.aborted).toBe(true);
	f.deps.workspace.lastFocusedSurfaceId = surfaceId;
	placement.release(surfaceId);
	await work;
	expect(f.panel.navigateToTranscriptRow).not.toHaveBeenCalled();
	expect(f.deps.notifications.info).not.toHaveBeenCalled();
	expect(f.deps.notifications.error).not.toHaveBeenCalled();
});

it.each(['current', 'superseded'] as const)(
	'reports a panel deadline only while %s',
	async (ownership) => {
		vi.useFakeTimers();
		const f = fixture();
		f.panel.navigateToTranscriptRow.mockImplementation(async (_target, signal) => {
			await new Promise<void>((resolve) =>
				signal.addEventListener('abort', () => resolve(), { once: true }),
			);
			return 'cancelled';
		});
		const work = f.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.panel.navigateToTranscriptRow).toHaveBeenCalledOnce();
		if (ownership === 'superseded') f.setAuthority('new-authority');
		await vi.advanceTimersByTimeAsync(30_000);
		await work;
		expect(f.deps.notifications.error).toHaveBeenCalledTimes(ownership === 'current' ? 1 : 0);
		if (ownership === 'current')
			expect(f.deps.notifications.error).toHaveBeenCalledWith(
				'Could not open issue source. Try again.',
			);
		expect(f.deps.notifications.info).not.toHaveBeenCalled();
	},
);
