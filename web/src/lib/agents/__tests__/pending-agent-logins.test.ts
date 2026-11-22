import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentAuthLoginStatus, getAgentAuthStatus } from '$lib/api/agents.js';
import { fetchModelCatalogResponse } from '$lib/api/model-catalog';
import { ApiError } from '$lib/api/client';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import { nativeCatalogAgent } from '../../../test/model-catalog';
import { ModelCatalogStore } from '../model-catalog-store.svelte';

vi.mock('$lib/api/agents.js', () => ({ getAgentAuthLoginStatus: vi.fn(), getAgentAuthStatus: vi.fn() }));
vi.mock('$lib/api/model-catalog', () => ({ fetchModelCatalogResponse: vi.fn() }));

const succeeded = { state: 'succeeded', sessionId: 'test-login', running: false, instanceId: remoteExecutor.instanceId } as const;

describe('executor-owned pending logins', () => {
	beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(fetchModelCatalogResponse).mockReset(); });
	afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

	it.each([
		{ error: new DOMException('Test timeout', 'TimeoutError'), validated: true },
		{ error: new ApiError(429, 'Executor busy', 'EXECUTOR_BUSY'), validated: true },
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
			await worker.refreshIfStale();
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(fetchModelCatalogResponse).toHaveBeenCalledOnce();
			await worker.refreshIfStale();
			expect(fetchModelCatalogResponse).toHaveBeenCalledTimes(2);
			expect(fetchModelCatalogResponse).toHaveBeenLastCalledWith(remoteExecutor.id, null, remoteExecutor.instanceId);
			expect(worker.isStale()).toBe(false);
		}
	});

	it('keeps the same owner login on reauthentication and clears its mounted listener on owner change', async () => {
		const catalog = new ModelCatalogStore();
		const worker = catalog.forExecutor(remoteExecutor.id);
		catalog.setOwner('owner-a');
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue({
			state: 'running', running: true, completionPending: false, sessionId: succeeded.sessionId,
		});
		const listener = vi.fn();
		worker.pendingLogins.observe('antigravity', succeeded.sessionId, listener);
		await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
		catalog.setOwner('owner-a');
		expect(worker.pendingLogins.sessionId('antigravity')).toBe(succeeded.sessionId);
		catalog.setOwner('owner-b');
		expect(worker.pendingLogins.sessionId('antigravity')).toBeUndefined();
		expect(listener).toHaveBeenLastCalledWith({ state: 'cleared' });
	});

	it('refreshes only the reconnected worker after a detached login succeeds', async () => {
		const catalog = new ModelCatalogStore();
		catalog.reconcileExecutors([localExecutor, remoteExecutor]);
		const worker = catalog.forExecutor(remoteExecutor.id);
		worker.lastValidatedAt = Date.now();
		const terminal = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthLoginStatus>>>();
		vi.mocked(getAgentAuthLoginStatus).mockReturnValue(terminal.promise);
		vi.mocked(getAgentAuthStatus).mockResolvedValue({ authenticated: true, canReauth: true, label: 'Test account' });
		vi.mocked(fetchModelCatalogResponse).mockResolvedValue(new Response(null, { status: 304 }));
		const detach = worker.pendingLogins.observe('antigravity', succeeded.sessionId, () => {});
		detach();
		catalog.reconcileExecutors([localExecutor, { ...remoteExecutor, availability: 'reconnecting' }]);
		expect(worker.isValidated).toBe(false);
		expect(worker.pendingLogins.sessionId('antigravity')).toBe(succeeded.sessionId);
		catalog.reconcileExecutors([localExecutor, remoteExecutor]);
		terminal.resolve(succeeded);
		await vi.advanceTimersByTimeAsync(1500);
		expect(fetchModelCatalogResponse).toHaveBeenCalledExactlyOnceWith(remoteExecutor.id, null, remoteExecutor.instanceId);
		expect(worker.isValidated).toBe(true);
	});

	it('does not publish or persist an in-flight login refresh after the browser owner changes', async () => {
		const catalog = new ModelCatalogStore();
		const worker = catalog.forExecutor(remoteExecutor.id);
		catalog.setOwner('owner-a');
		const response = Promise.withResolvers<Response>();
		vi.mocked(fetchModelCatalogResponse).mockReturnValueOnce(response.promise);
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue(succeeded);
		vi.mocked(getAgentAuthStatus).mockResolvedValue({ authenticated: true, canReauth: true, label: 'Test account' });
		worker.pendingLogins.observe('antigravity', succeeded.sessionId, () => {});
		await vi.waitFor(() => expect(fetchModelCatalogResponse).toHaveBeenCalledOnce());
		catalog.setOwner('owner-a');
		expect(worker.isRefreshing).toBe(true);
		catalog.setOwner(null);
		const agents = [nativeCatalogAgent('antigravity', [{ value: 'old', label: 'Old model' }])];
		response.resolve(Response.json({ catalog: { agents, apiProviders: [] } }));
		await vi.advanceTimersByTimeAsync(0);
		expect(worker.isRefreshing).toBe(false);
		expect(worker.isValidated).toBe(false);
		expect(worker.getModels('antigravity')).toEqual([]);
		expect(new ModelCatalogStore(remoteExecutor.id).getModels('antigravity')).toEqual([]);
		catalog.setOwner('owner-b');
		vi.mocked(fetchModelCatalogResponse).mockResolvedValueOnce(Response.json({
			catalog: { agents: [nativeCatalogAgent('antigravity')], apiProviders: [] },
		}));
		await worker.forceRefresh();
		expect(worker.isValidated).toBe(true);
	});

	it.each(['worker reconnect', 'provider edit'])('revalidates on demand after a %s, ignoring the old reply', async change => {
		const catalog = new ModelCatalogStore();
		catalog.reconcileExecutors([remoteExecutor]);
		const worker = catalog.forExecutor(remoteExecutor.id);
		const stale = Promise.withResolvers<Response>();
		vi.mocked(fetchModelCatalogResponse).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(Response.json({
			catalog: { agents: [nativeCatalogAgent('antigravity', [{ value: 'fresh', label: 'Fresh' }])], apiProviders: [] },
		}));
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue(succeeded);
		vi.mocked(getAgentAuthStatus).mockResolvedValue({ authenticated: true, canReauth: true, label: 'Test account' });
		const detach = worker.pendingLogins.observe('antigravity', succeeded.sessionId, () => {});
		detach();
		await vi.waitFor(() => expect(fetchModelCatalogResponse).toHaveBeenCalledOnce());
		if (change === 'provider edit') catalog.invalidateAll();
		else {
			catalog.reconcileExecutors([{ ...remoteExecutor, availability: 'reconnecting' }]);
			catalog.reconcileExecutors([remoteExecutor]);
		}
		stale.resolve(Response.json({ catalog: { agents: [nativeCatalogAgent('antigravity')], apiProviders: [] } }));
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchModelCatalogResponse).toHaveBeenCalledOnce();
		expect(worker.isStale()).toBe(true);
		await worker.refreshIfStale();
		expect(fetchModelCatalogResponse).toHaveBeenCalledTimes(2);
		expect(fetchModelCatalogResponse).toHaveBeenLastCalledWith(remoteExecutor.id, null, remoteExecutor.instanceId);
		expect(worker.getModels('antigravity')).toMatchObject([{ value: 'fresh' }]);
	});

	it('drops confirmation when HTTP detects replacement before the browser executor snapshot arrives', async () => {
		const worker = new ModelCatalogStore(remoteExecutor.id);
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue(succeeded);
		vi.mocked(getAgentAuthStatus).mockRejectedValueOnce(new ApiError(409, 'Worker replaced', 'LOGIN_INSTANCE_CHANGED'));
		worker.pendingLogins.observe('antigravity', succeeded.sessionId, () => {});
		await vi.advanceTimersByTimeAsync(3000);
		expect(getAgentAuthStatus).toHaveBeenCalledExactlyOnceWith('antigravity', remoteExecutor.id, remoteExecutor.instanceId);
		expect(worker.pendingLogins.sessionId('antigravity')).toBeUndefined();
		expect(fetchModelCatalogResponse).not.toHaveBeenCalled();
	});

	it.each(['replaced', 'removed', 'disabled', 'offline'])('retires an outstanding credential check when the executor is %s', async change => {
		const catalog = new ModelCatalogStore();
		catalog.reconcileExecutors([localExecutor, remoteExecutor]);
		const worker = catalog.forExecutor(remoteExecutor.id);
		const refresh = vi.spyOn(worker, 'forceRefresh').mockResolvedValue();
		const confirmation = Promise.withResolvers<Awaited<ReturnType<typeof getAgentAuthStatus>>>();
		vi.mocked(getAgentAuthLoginStatus).mockResolvedValue(succeeded);
		vi.mocked(getAgentAuthStatus).mockReturnValue(confirmation.promise);
		const detach = worker.pendingLogins.observe('antigravity', succeeded.sessionId, () => {});
		await vi.waitFor(() => expect(getAgentAuthStatus).toHaveBeenCalledWith('antigravity', remoteExecutor.id, remoteExecutor.instanceId));
		detach();
		const executor = { ...remoteExecutor,
			enabled: change !== 'disabled',
			availability: change === 'offline' ? 'offline' as const : remoteExecutor.availability,
			instanceId: change === 'replaced' ? 'replacement' : remoteExecutor.instanceId,
		};
		catalog.reconcileExecutors(change === 'removed' ? [localExecutor] : [localExecutor, executor]);
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
