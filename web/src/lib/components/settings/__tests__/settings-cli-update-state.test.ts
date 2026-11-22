import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliUpdateStatus, AgentCliUpdatesResponse } from '$shared/agent-cli-update';
import { ApiError } from '$lib/api/client.js';
import { SettingsCliUpdateState, type CliUpdateApi } from '../settings-cli-update-state.svelte.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';
const IDLE = { state: 'idle', startedAt: null, finishedAt: null, message: null, output: null } as const;
const BEHIND: AgentCliUpdateStatus = {
	cliLabel: 'Claude Code',
	installMethod: 'native',
	installPath: '/home/synthetic/.local/share/claude/versions/2.1.238',
	currentVersion: '2.1.238',
	latestVersion: '2.1.300',
	advisory: 'behind-latest',
	updateCommand: '/home/synthetic/.local/bin/claude update',
	canUpdate: true,
	message: null,
	checkedAt: '2026-11-20T00:00:00.000Z',
	run: IDLE,
};
const RUNNING: AgentCliUpdateStatus = {
	...BEHIND,
	run: { ...IDLE, state: 'running', startedAt: '2026-11-20T00:00:01.000Z', message: 'Checking for the latest version' },
};
const SUCCEEDED: AgentCliUpdateStatus = {
	...BEHIND,
	currentVersion: '2.1.300',
	advisory: 'current',
	run: { ...IDLE, state: 'succeeded', message: 'Updated Claude Code to 2.1.300.' },
};

function createApi(responses: AgentCliUpdatesResponse[]) {
	const reads: Array<{ executorId: string; refresh: boolean }> = [];
	const starts: Array<{ agentId: string; executorId: string }> = [];
	const api = {
		getAgentCliUpdates: vi.fn(async (executorId: string, options: { readonly refresh: boolean }) => {
			reads.push({ executorId, refresh: options.refresh });
			return responses.length > 1 ? responses.shift()! : responses[0]!;
		}),
		startAgentCliUpdate: vi.fn(async (agentId: string, executorId: string) => {
			starts.push({ agentId, executorId });
			return RUNNING;
		}),
	} satisfies CliUpdateApi;
	return { api, reads, starts };
}

describe('SettingsCliUpdateState', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it('loads statuses for its executor and refreshes on an explicit check', async () => {
		const { api, reads } = createApi([{ statuses: { claude: BEHIND }, failures: { codex: 'codex was not found' } }]);
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		const dispose = state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		expect(state.checkFailureFor('codex')).toBe('codex was not found');
		await state.checkForUpdates();
		expect(reads).toEqual([{ executorId: EXECUTOR, refresh: false }, { executorId: EXECUTOR, refresh: true }]);
		dispose();
		expect(state.statusFor('claude')).toBeUndefined();
	});

	it('polls a running update until it settles', async () => {
		const { api, starts } = createApi([
			{ statuses: { claude: BEHIND }, failures: {} },
			{ statuses: { claude: RUNNING }, failures: {} },
			{ statuses: { claude: SUCCEEDED }, failures: {} },
		]);
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		await state.startUpdate('claude');
		expect(starts).toEqual([{ agentId: 'claude', executorId: EXECUTOR }]);
		expect(state.statusFor('claude')?.run.state).toBe('running');

		await state.startUpdate('claude');
		expect(starts).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.statusFor('claude')?.run.state).toBe('running');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.statusFor('claude')).toEqual(SUCCEEDED);
		expect(api.getAgentCliUpdates).toHaveBeenLastCalledWith(EXECUTOR, { refresh: false, agentIds: ['claude'] });
		const readsAfterSettle = api.getAgentCliUpdates.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api.getAgentCliUpdates.mock.calls.length).toBe(readsAfterSettle);
	});

	it('keeps polling a running update after a failed read', async () => {
		const { api } = createApi([
			{ statuses: { claude: RUNNING }, failures: {} },
			{ statuses: { claude: SUCCEEDED }, failures: {} },
		]);
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')?.run.state).toBe('running'));
		api.getAgentCliUpdates.mockRejectedValueOnce(new Error('Executor is reconnecting'));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.loadError).toBe('Executor is reconnecting');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.statusFor('claude')).toEqual(SUCCEEDED);
		expect(state.loadError).toBeNull();
	});

	it('lists the agents the executor reported, native agents first', async () => {
		const { api } = createApi([{ statuses: { zeta: BEHIND, codex: BEHIND }, failures: { claude: 'timed out', alpha: 'missing' } }]);
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.agentIds).toEqual(['claude', 'codex', 'alpha', 'zeta']));
	});

	it('reports a rejected start without changing the status', async () => {
		const { api } = createApi([{ statuses: { claude: BEHIND }, failures: {} }]);
		api.startAgentCliUpdate.mockRejectedValueOnce(new Error('Update it with the tool that installed it.'));
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		await state.startUpdate('claude');
		expect(state.startErrorFor('claude')).toBe('Update it with the tool that installed it.');
		expect(state.checkFailureFor('claude')).toBeUndefined();
		expect(state.isStarting('claude')).toBe(false);
		expect(state.statusFor('claude')).toEqual(BEHIND);
	});

	it('finds a run whose start reply was lost', async () => {
		const { api } = createApi([
			{ statuses: { claude: BEHIND }, failures: {} },
			{ statuses: { claude: RUNNING }, failures: {} },
			{ statuses: { claude: SUCCEEDED }, failures: {} },
		]);
		api.startAgentCliUpdate.mockRejectedValueOnce(new Error('Request timed out'));
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		await state.startUpdate('claude');
		await vi.waitFor(() => expect(state.statusFor('claude')?.run.state).toBe('running'));
		expect(api.getAgentCliUpdates).toHaveBeenLastCalledWith(EXECUTOR, { refresh: false, agentIds: ['claude'] });
		expect(state.startErrorFor('claude')).toBeUndefined();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.statusFor('claude')).toEqual(SUCCEEDED);
	});

	it('keeps a started run when an earlier check answers after it', async () => {
		let answerCheck!: (response: AgentCliUpdatesResponse) => void;
		const { api } = createApi([{ statuses: { claude: BEHIND }, failures: {} }]);
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		api.getAgentCliUpdates.mockImplementationOnce(() => new Promise((resolve) => { answerCheck = resolve; }));
		const checking = state.checkForUpdates();
		await state.startUpdate('claude');
		answerCheck({ statuses: { claude: BEHIND }, failures: {} });
		await checking;
		expect(state.statusFor('claude')?.run.state).toBe('running');
		await vi.advanceTimersByTimeAsync(2_000);
		expect(api.getAgentCliUpdates).toHaveBeenLastCalledWith(EXECUTOR, { refresh: false, agentIds: ['claude'] });
	});

	it('keeps a recovery read when another agent is polled meanwhile', async () => {
		const codexRunning = { ...RUNNING, cliLabel: 'Codex CLI' };
		let answerRecovery!: (response: AgentCliUpdatesResponse) => void;
		const { api } = createApi([{ statuses: { claude: BEHIND, codex: codexRunning }, failures: {} }]);
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('codex')?.run.state).toBe('running'));
		api.startAgentCliUpdate.mockRejectedValueOnce(new Error('Request timed out'));
		api.getAgentCliUpdates.mockImplementationOnce(() => new Promise((resolve) => { answerRecovery = resolve; }));
		await state.startUpdate('claude');
		api.getAgentCliUpdates.mockResolvedValueOnce({ statuses: { codex: codexRunning }, failures: {} });
		await vi.advanceTimersByTimeAsync(2_000);
		answerRecovery({ statuses: { claude: RUNNING }, failures: {} });
		await vi.waitFor(() => expect(state.statusFor('claude')?.run.state).toBe('running'));
		expect(state.startErrorFor('claude')).toBeUndefined();
	});

	it('clears a failed start once its run is seen, even after it finished', async () => {
		const { api } = createApi([
			{ statuses: { claude: BEHIND }, failures: {} },
			{ statuses: { claude: { ...SUCCEEDED, run: { ...SUCCEEDED.run, startedAt: '2026-11-20T00:00:05.000Z' } } }, failures: {} },
		]);
		api.startAgentCliUpdate.mockRejectedValueOnce(new Error('Request timed out'));
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		await state.startUpdate('claude');
		await vi.waitFor(() => expect(state.statusFor('claude')?.run.state).toBe('succeeded'));
		expect(state.startErrorFor('claude')).toBeUndefined();
	});

	it('keeps a definite refusal without reading the status again', async () => {
		const { api } = createApi([{ statuses: { claude: BEHIND }, failures: {} }]);
		api.startAgentCliUpdate.mockRejectedValueOnce(new ApiError(422, 'Garcon runs its bundled Codex CLI.', 'OPERATION_UNSUPPORTED'));
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		const reads = api.getAgentCliUpdates.mock.calls.length;
		await state.startUpdate('claude');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.getAgentCliUpdates.mock.calls.length).toBe(reads);
		expect(state.startErrorFor('claude')).toBe('Garcon runs its bundled Codex CLI.');
	});

	it('reads the status again after an intermediary answers a start', async () => {
		const { api } = createApi([{ statuses: { claude: BEHIND }, failures: {} }]);
		api.startAgentCliUpdate.mockRejectedValueOnce(new ApiError(429, 'Too Many Requests'));
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		await state.startUpdate('claude');
		await vi.waitFor(() =>
			expect(api.getAgentCliUpdates).toHaveBeenLastCalledWith(EXECUTOR, { refresh: false, agentIds: ['claude'] }));
	});

	it('keeps a refusal that follows an uncertain start', async () => {
		const later = { ...SUCCEEDED, run: { ...SUCCEEDED.run, startedAt: '2026-11-20T00:00:09.000Z' } };
		const { api } = createApi([
			{ statuses: { claude: BEHIND }, failures: {} },
			{ statuses: { claude: BEHIND }, failures: {} },
			{ statuses: { claude: later }, failures: {} },
		]);
		api.startAgentCliUpdate
			.mockRejectedValueOnce(new Error('Request timed out'))
			.mockRejectedValueOnce(new ApiError(422, 'Update it with the tool that installed it.', 'OPERATION_UNSUPPORTED'));
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		await state.startUpdate('claude');
		await vi.waitFor(() => expect(api.getAgentCliUpdates).toHaveBeenCalledTimes(2));
		await state.startUpdate('claude');
		await state.checkForUpdates();
		expect(state.statusFor('claude')).toEqual(later);
		expect(state.startErrorFor('claude')).toBe('Update it with the tool that installed it.');
	});

	it('ignores responses that arrive after it is destroyed', async () => {
		let resolveRead!: (response: AgentCliUpdatesResponse) => void;
		const api = {
			getAgentCliUpdates: vi.fn(() => new Promise<AgentCliUpdatesResponse>((resolve) => { resolveRead = resolve; })),
			startAgentCliUpdate: vi.fn(async () => RUNNING),
		} satisfies CliUpdateApi;
		const state = new SettingsCliUpdateState(EXECUTOR, ['claude', 'codex'], api);
		const dispose = state.initialize();
		dispose();
		resolveRead({ statuses: { claude: RUNNING }, failures: {} });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.statusFor('claude')).toBeUndefined();
		expect(api.getAgentCliUpdates).toHaveBeenCalledTimes(1);
	});
});
