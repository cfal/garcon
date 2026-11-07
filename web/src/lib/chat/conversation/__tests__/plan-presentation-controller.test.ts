import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitPlanModeToolUseMessage } from '$shared/chat-types';
import type { PlanPresentationDetail, PlanPresentationSnapshot } from '$shared/transcript-display-open';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display';
import type { PendingPermissionRequest } from '$lib/types/chat';
import { PlanPresentationController, type PlanPresentationPort, type PlanPresentationView } from '../plan-presentation-controller';

const identity = { serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-1' };
function snapshot(ordinals = [10, 20], nextAfterOrdinal: number | null = null): PlanPresentationSnapshot {
	return { ...identity, revision: 1, latestEnterOrdinal: 1, pendingExitCount: 3,
		exits: ordinals.map(ordinal => ({ ordinal, timestamp: '2026-01-01T00:00:00.000Z' })), nextAfterOrdinal };
}
const controllers: PlanPresentationController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.destroy(); });
function fixture() {
	let instance = 'instance-1', view = 'view-1', rendered = true;
	let pending: PendingPermissionRequest[] = [], presentation: PlanPresentationView | null = null;
	const api = {
		plan: vi.fn<TranscriptDisplayApi['plan']>().mockImplementation(async request => request.afterOrdinal ? snapshot([30]) : snapshot()),
		planDetail: vi.fn<TranscriptDisplayApi['planDetail']>().mockImplementation(async request => ({ ...request, ordinal: request.ordinal!,
			message: new ExitPlanModeToolUseMessage('2026-01-01T00:00:00.000Z', 'reused-tool', `Synthetic plan ${request.ordinal}`) })),
	};
	const port = {
		isCurrent: request => request.serverInstanceId === instance && request.transcriptViewId === view,
		isRenderedChat: () => rendered,
		getPermissionMode: () => 'default',
		setPermissionMode: vi.fn(),
		onError: vi.fn(),
		conversationUi: {
			beginPlanModeForChat: vi.fn(),
			setPlanPresentation: (_chatId, next) => { presentation = next; },
			updatePendingPermissionsForChat: (_chatId, update) => { pending = typeof update === 'function' ? update(pending) : update; },
		},
	} satisfies PlanPresentationPort;
	const controller = new PlanPresentationController(port, api);
	controllers.push(controller);
	return { controller, api, port, get presentation() { return presentation!; }, get pending() { return pending; },
		setAuthority(nextInstance: string, nextView = view) { instance = nextInstance; view = nextView; pending = []; presentation = null; },
		setRendered(value: boolean) { rendered = value; },
	};
}

describe('plan presentation ownership', () => {
	it.each([null, 0, 1])('uses the known head %s to distinguish a first live plan entry from history', async knownThrough => {
		const test = fixture();
		test.setRendered(false);
		test.controller.refresh(identity, 1, knownThrough);
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		expect(test.port.setPermissionMode.mock.calls).toEqual(knownThrough === 0 ? [['chat-1', 'plan']] : []);
		expect(test.api.planDetail).not.toHaveBeenCalled();
	});
	it('preserves selection and enter-mode handling on same-revision installs', async () => {
		const test = fixture();
		test.controller.install(snapshot());
		await vi.waitFor(() => expect(test.pending[0]?.planReference?.ordinal).toBe(10));
		await test.presentation.next();
		expect(test.pending[0]?.planReference?.ordinal).toBe(20);
		test.controller.install(snapshot());
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		expect(test.pending[0]?.planReference?.ordinal).toBe(20);
		expect(test.port.setPermissionMode).not.toHaveBeenCalled();
	});

	it('does not restore historical plan mode but handles a new live entry', async () => {
		const test = fixture();
		test.controller.install(snapshot());
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		expect(test.port.setPermissionMode).not.toHaveBeenCalled();
		test.controller.install({ ...snapshot(), revision: 2, latestEnterOrdinal: 25 });
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		expect(test.port.setPermissionMode).toHaveBeenCalledExactlyOnceWith('chat-1', 'plan');
	});

	it('retries failed newer metadata instead of accepting its old installed snapshot', async () => {
		const test = fixture();
		test.controller.install(snapshot([10]));
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		test.api.plan.mockRejectedValueOnce(new Error('Metadata unavailable')).mockResolvedValueOnce({ ...snapshot([20]), revision: 2 });
		test.controller.refresh(identity, 2);
		await vi.waitFor(() => expect(test.presentation.error).toBe('Metadata unavailable'));
		expect(test.pending[0]?.planReference?.ordinal).toBe(10);
		await test.presentation.retry();
		expect(test.api.plan).toHaveBeenCalledTimes(2);
		expect(test.pending[0]?.planReference?.ordinal).toBe(20);
		expect(test.presentation.error).toBeNull();
	});

	it('hydrates the selected plan when a background chat becomes rendered', async () => {
		const test = fixture();
		test.setRendered(false);
		test.controller.install(snapshot());
		expect(test.pending).toEqual([]);
		expect(test.api.planDetail).not.toHaveBeenCalled();
		test.setRendered(true);
		test.controller.install(snapshot());
		await vi.waitFor(() => expect(test.pending).toHaveLength(1));
	});

	it.each(['instance', 'view'] as const)('fences late plan metadata after a %s change', async kind => {
		const test = fixture(), held = Promise.withResolvers<PlanPresentationSnapshot>();
		test.api.plan.mockReturnValueOnce(held.promise);
		test.controller.refresh(identity, 1);
		test.setAuthority(kind === 'instance' ? 'instance-2' : 'instance-1', kind === 'view' ? 'view-2' : 'view-1');
		held.resolve(snapshot());
		await Promise.resolve(); await Promise.resolve();
		expect(test.pending).toEqual([]);
		expect(test.port.setPermissionMode).not.toHaveBeenCalled();
		expect(test.api.planDetail).not.toHaveBeenCalled();
	});

	it('fences late plan bodies after socket confirmation of a restart', async () => {
		const test = fixture(), held = Promise.withResolvers<PlanPresentationDetail>();
		test.api.planDetail.mockReturnValueOnce(held.promise);
		test.controller.install(snapshot());
		test.setAuthority('instance-2');
		held.resolve({ ...identity, ordinal: 10, message: new ExitPlanModeToolUseMessage('', 'tool', 'Synthetic plan') });
		await Promise.resolve(); await Promise.resolve();
		expect(test.pending).toEqual([]);
		expect(test.presentation).toBeNull();
	});

	it('retries a failed first read with its captured identity', async () => {
		const test = fixture();
		test.api.plan.mockRejectedValueOnce(new Error('Temporary failure'));
		test.controller.refresh(identity, 1);
		await vi.waitFor(() => expect(test.presentation.error).toBe('Temporary failure'));
		await test.presentation.retry();
		expect(test.api.plan).toHaveBeenCalledTimes(2);
		expect(test.pending[0]?.planReference?.ordinal).toBe(10);
	});

	it('commits pagination history only after the page succeeds', async () => {
		const test = fixture();
		test.controller.install(snapshot([10, 20], 20));
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		await test.presentation.next();
		test.api.plan.mockRejectedValueOnce(new Error('Temporary failure'));
		await test.presentation.next();
		expect(test.pending[0]?.planReference?.ordinal).toBe(20);
		await test.presentation.retry();
		expect(test.api.plan.mock.calls.map(call => call[0].afterOrdinal)).toEqual([20, 20]);
		expect(test.pending[0]?.planReference?.ordinal).toBe(30);
		await test.presentation.previous();
		expect(test.api.plan.mock.calls.at(-1)?.[0].afterOrdinal).toBe(0);
		expect(test.pending[0]?.planReference?.ordinal).toBe(20);
	});

	it('keeps a selected occurrence on a later page when the plan revision advances', async () => {
		const test = fixture();
		test.controller.install(snapshot([10, 20], 20));
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		await test.presentation.next(); await test.presentation.next();
		test.api.plan.mockResolvedValueOnce({ ...snapshot([30, 40]), revision: 2 });
		test.controller.install({ ...snapshot([10, 20], 20), revision: 2 });
		await vi.waitFor(() => expect(test.presentation.loading).toBe(false));
		expect(test.api.plan.mock.calls.at(-1)?.[0].afterOrdinal).toBe(20);
		expect(test.pending[0]?.planReference?.ordinal).toBe(30);
	});
});
