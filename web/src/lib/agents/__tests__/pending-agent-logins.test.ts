import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentAuthLoginStatus, getAgentAuthStatus } from '$lib/api/agents.js';
import { fetchModelCatalogResponse } from '$lib/api/model-catalog';
import { ApiError } from '$lib/api/client';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { ModelCatalogStore } from '../model-catalog-store.svelte';

vi.mock('$lib/api/agents.js', () => ({ getAgentAuthLoginStatus: vi.fn(), getAgentAuthStatus: vi.fn() }));
vi.mock('$lib/api/model-catalog', () => ({ fetchModelCatalogResponse: vi.fn() }));

const succeeded = { state: 'succeeded', sessionId: 'test-login', running: false } as const;

describe('executor-owned pending logins', () => {
	beforeEach(() => { vi.useFakeTimers(); vi.mocked(fetchModelCatalogResponse).mockReset(); });
	afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

	it.each([
		{ error: new DOMException('Test timeout', 'TimeoutError'), validated: true },
		{ error: new ApiError(503, 'Executor offline', 'EXECUTOR_UNAVAILABLE'), validated: false },
	])('preserves prior admission on a transport timeout but not on an authoritative error: $error.message', async ({ error, validated }) => {
		const worker = new ModelCatalogStore(remoteExecutor.id);
		worker.lastValidatedAt = Date.now();
		vi.mocked(fetchModelCatalogResponse).mockRejectedValueOnce(error)
			.mockResolvedValueOnce(new Response(null, { status: 304 }));
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue(succeeded);
		vi.mocked(getAgentAuthStatus).mockResolvedValue({ authenticated: true, canReauth: true, label: 'Test account' });
		worker.pendingLogins.observe('antigravity', succeeded.sessionId, () => {});
		await vi.waitFor(() => expect(fetchModelCatalogResponse).toHaveBeenCalledOnce());
		expect(worker.isValidated).toBe(validated);
		if (validated) {
			expect(worker.isStale()).toBe(true);
			await vi.advanceTimersByTimeAsync(30_000);
			await worker.refreshIfStale();
			expect(fetchModelCatalogResponse).toHaveBeenCalledTimes(2);
			expect(worker.isStale()).toBe(false);
		}
	});

	it('keeps the same owner login on reauthentication and clears its mounted listener on owner change', async () => {
		const catalog = new ModelCatalogStore();
		const worker = catalog.forExecutor(remoteExecutor.id);
		catalog.setLoginOwner('owner-a');
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'running', running: true, completionPending: false, sessionId: succeeded.sessionId,
		});
		const listener = vi.fn();
		worker.pendingLogins.observe('antigravity', succeeded.sessionId, listener);
		await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
		catalog.setLoginOwner('owner-a');
		expect(worker.pendingLogins.sessionId('antigravity')).toBe(succeeded.sessionId);
		catalog.setLoginOwner('owner-b');
		expect(worker.pendingLogins.sessionId('antigravity')).toBeUndefined();
		expect(listener).toHaveBeenLastCalledWith({ state: 'cleared' });
	});

	it.each(['replaced', 'removed'])('retires an outstanding credential check when the executor is %s', async change => {
		const catalog = new ModelCatalogStore();
		catalog.reconcileExecutors([localExecutor, remoteExecutor]);
		const worker = catalog.forExecutor(remoteExecutor.id);
		const refresh = vi.spyOn(worker, 'forceRefresh').mockResolvedValue();
		const confirmation = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthStatus>>>();
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue(succeeded);
		vi.mocked(getAgentAuthStatus).mockReturnValue(confirmation.promise);
		const detach = worker.pendingLogins.observe('antigravity', succeeded.sessionId, () => {});
		await vi.waitFor(() => expect(getAgentAuthStatus).toHaveBeenCalledWith('antigravity', remoteExecutor.id));
		detach();
		catalog.reconcileExecutors(change === 'removed' ? [localExecutor] : [
			localExecutor, { ...remoteExecutor, instanceId: 'replacement' },
		]);
		confirmation.resolve({ authenticated: true, canReauth: true, label: 'Test account' });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(worker.pendingLogins.sessionId('antigravity')).toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
		expect(getAgentAuthStatus).toHaveBeenCalledTimes(1);
	});

	it('expires a detached session even when its status request never settled', async () => {
		const worker = new ModelCatalogStore(remoteExecutor.id);
		const terminal = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthLoginStatus>>>();
		vi.mocked(getAgentAuthLoginStatus).mockReturnValue(terminal.promise);
		const listener = vi.fn();
		const detach = worker.pendingLogins.observe('antigravity', succeeded.sessionId, listener);
		detach();
		await vi.runAllTimersAsync();
		expect(worker.pendingLogins.sessionId('antigravity')).toBeUndefined();
		terminal.resolve(succeeded);
		await vi.advanceTimersByTimeAsync(1500);
		expect(getAgentAuthStatus).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
	});
});
