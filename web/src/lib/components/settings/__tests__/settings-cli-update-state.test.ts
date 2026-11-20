import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliUpdateStatus, AgentCliUpdatesResponse } from '$shared/agent-cli-update';
import { SettingsCliUpdateState, type CliUpdateApi } from '../settings-cli-update-state.svelte.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';
const IDLE = { state: 'idle', startedAt: null, finishedAt: null, message: null, output: null } as const;
const BEHIND: AgentCliUpdateStatus = {
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
		const state = new SettingsCliUpdateState(EXECUTOR, api);
		const dispose = state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		expect(state.failureFor('codex')).toBe('codex was not found');
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
		const state = new SettingsCliUpdateState(EXECUTOR, api);
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
		const readsAfterSettle = api.getAgentCliUpdates.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api.getAgentCliUpdates.mock.calls.length).toBe(readsAfterSettle);
	});

	it('reports a rejected start without changing the status', async () => {
		const { api } = createApi([{ statuses: { claude: BEHIND }, failures: {} }]);
		api.startAgentCliUpdate.mockRejectedValueOnce(new Error('Update it with the tool that installed it.'));
		const state = new SettingsCliUpdateState(EXECUTOR, api);
		state.initialize();
		await vi.waitFor(() => expect(state.statusFor('claude')).toEqual(BEHIND));
		await state.startUpdate('claude');
		expect(state.failureFor('claude')).toBe('Update it with the tool that installed it.');
		expect(state.isStarting('claude')).toBe(false);
		expect(state.statusFor('claude')).toEqual(BEHIND);
	});

	it('ignores responses that arrive after it is destroyed', async () => {
		let resolveRead!: (response: AgentCliUpdatesResponse) => void;
		const api = {
			getAgentCliUpdates: vi.fn(() => new Promise<AgentCliUpdatesResponse>((resolve) => { resolveRead = resolve; })),
			startAgentCliUpdate: vi.fn(async () => RUNNING),
		} satisfies CliUpdateApi;
		const state = new SettingsCliUpdateState(EXECUTOR, api);
		const dispose = state.initialize();
		dispose();
		resolveRead({ statuses: { claude: RUNNING }, failures: {} });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(state.statusFor('claude')).toBeUndefined();
		expect(api.getAgentCliUpdates).toHaveBeenCalledTimes(1);
	});
});
