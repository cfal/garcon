import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowActiveChat, WorkflowPage, WorkflowRunSummary } from '$shared/workflow-runs';
import { SidebarWorkflowIndex } from '../sidebar-workflow-index.svelte';
import { buildSidebarRowModel } from '../sidebar-row-model';
import { chat, projectionInput } from './sidebar-fixtures';

function page<T>(items: readonly T[], nextCursor: string | null = null): WorkflowPage<T> {
	return { items, nextCursor };
}

const timestamp = '2026-11-21T00:00:00Z';
function run(id: string, status: WorkflowRunSummary['status'] = 'running'): WorkflowRunSummary {
	return {
		id,
		kind: 'published',
		definitionId: 'definition',
		revision: 1,
		name: id,
		status,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function membership(chatId: string, parent: WorkflowRunSummary): WorkflowActiveChat {
	return {
		chatId,
		runId: parent.id,
		runName: parent.name,
		runStatus: parent.status,
		runUpdatedAt: parent.updatedAt,
		stepId: 'step',
		instanceId: 'instance',
		attemptId: 'attempt',
		status: 'running',
	};
}

let current: SidebarWorkflowIndex | undefined;
function create(
	readers: ConstructorParameters<typeof SidebarWorkflowIndex>[0],
): SidebarWorkflowIndex {
	return (current = new SidebarWorkflowIndex(readers));
}

afterEach(() => current?.setLive(false));

describe('workflow sidebar index', () => {
	it('keeps a run outside the recent page visible and does not drop it when loading history', async () => {
		const recent = run('recent', 'succeeded');
		const active = run('active');
		const older = run('older', 'succeeded');
		const readRuns = vi.fn<ConstructorParameters<typeof SidebarWorkflowIndex>[0]['runs']>(
			({ cursor }) => Promise.resolve(cursor ? page([active, older]) : page([recent], 'history')),
		);
		const index = create({
			runs: readRuns,
			activeChats: async () => page([membership('worker', active)]),
		});
		index.setLive(true);
		await vi.waitFor(() => expect(index.runs.map(({ id }) => id)).toEqual([recent.id, active.id]));
		expect(index.moreRuns).toBe(true);
		index.loadMore('runs');
		await vi.waitFor(() =>
			expect(index.runs.map(({ id }) => id)).toEqual([recent.id, active.id, older.id]),
		);
		expect(index.moreRuns).toBe(false);
		expect(index.runIdByChatId.get('worker')).toBe(active.id);
		expect(readRuns).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'history' }));
	});

	it('retains the selected finished child under its run until navigating to a different chat', async () => {
		let currentRun = run('run');
		let chats = [membership('selected', currentRun), membership('other', currentRun)];
		const index = create({
			runs: async () => page([currentRun]),
			activeChats: async () => page(chats),
		});
		const allChats = [chat('selected'), chat('other')];
		const row = (id: string) =>
			buildSidebarRowModel(projectionInput(allChats, { workflows: index })).rows.find(
				(entry) => entry.type === 'chat' && entry.chat.id === id,
			);
		index.selectChat('selected');
		index.setLive(true);
		await vi.waitFor(() => expect(row('selected')?.depth).toBe(1));
		expect(row('other')?.depth).toBe(1);
		currentRun = run('run', 'succeeded');
		chats = [];
		index.invalidate();
		await vi.waitFor(() => expect(row('other')?.depth).toBe(0));
		expect(row('selected')?.depth).toBe(1);
		index.selectChat('other');
		expect(row('selected')?.depth).toBe(0);
	});

	it('accepts viewer membership for a historical chat without retaining any other history', () => {
		const index = create({ runs: async () => page([]), activeChats: async () => page([]) });
		index.selectChat('historical', index.runForChat('historical', 'old-run'));
		expect(index.runIdByChatId.get('historical')).toBe('old-run');
		expect(index.runs).toEqual([{ id: 'old-run', name: '', status: null }]);
		index.selectChat(null);
		expect(index.runIdByChatId.size).toBe(0);
		expect(index.runs).toEqual([]);
	});

	it('refreshes only the active pages the user has loaded', async () => {
		const parent = run('run');
		let later = [membership('second', parent)];
		const activeChats = vi.fn<ConstructorParameters<typeof SidebarWorkflowIndex>[0]['activeChats']>(
			async ({ cursor }) => cursor ? page(later) : page([membership('first', parent)], 'next'),
		);
		const index = create({ runs: async () => page([]), activeChats });
		index.setLive(true);
		await vi.waitFor(() => expect(index.moreActiveChats).toBe(true));
		expect(activeChats).toHaveBeenCalledOnce();
		index.loadMore('active-chats');
		await vi.waitFor(() => expect(index.runIdByChatId.has('second')).toBe(true));
		later = [];
		index.invalidate();
		await vi.waitFor(() => expect(index.runIdByChatId.has('second')).toBe(false));
		expect(index.runIdByChatId.has('first')).toBe(true);
		expect(activeChats.mock.calls.map(([options]) => options.cursor)).toEqual([
			undefined, 'next', undefined, 'next',
		]);
	});

	it('retains the last good snapshot on failure and aborts an obsolete request when hidden', async () => {
		const selectedRun = run('run');
		const readRuns = vi
			.fn<ConstructorParameters<typeof SidebarWorkflowIndex>[0]['runs']>()
			.mockResolvedValueOnce(page([selectedRun]))
			.mockRejectedValueOnce(new Error('offline'));
		const index = create({ runs: readRuns, activeChats: async () => page([]) });
		index.setLive(true);
		await vi.waitFor(() => expect(index.runs).toEqual([selectedRun]));
		index.invalidate();
		await vi.waitFor(() => expect(index.failed).toBe(true));
		expect(index.runs).toEqual([selectedRun]);
		let lateReply!: (value: WorkflowPage<WorkflowRunSummary>) => void;
		readRuns.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					lateReply = resolve;
				}),
		);
		index.invalidate();
		const signal = readRuns.mock.lastCall?.[0].signal;
		index.setLive(false);
		expect(signal?.aborted).toBe(true);
		lateReply(page([run('stale')]));
		await Promise.resolve();
		expect(index.runs).toEqual([selectedRun]);
		expect(index.fetching).toBe(false);
	});
});
