import { describe, expect, it } from 'vitest';
import { buildSidebarRowModel, type SidebarRowModelInput } from '../sidebar-row-model';
import { chat, delegated, projectionInput } from './sidebar-fixtures';

const run = { id: 'workflow-1', name: 'Review', status: 'running' } as const;

function workflows(overrides: Partial<NonNullable<SidebarRowModelInput['workflows']>> = {}) {
	return {
		runs: [run],
		runIdByChatId: new Map([
			['worker', run.id],
			['attention', run.id],
		]),
		collapsedRunIds: new Set<string>(),
		moreRuns: false,
		moreActiveChats: false,
		...overrides,
	};
}

describe('sidebar workflow projection', () => {
	it('nests real chats exactly once without rewriting delegation', () => {
		const worker = delegated('worker', 'ordinary', { isProcessing: true, executorId: 'remote' });
		const ordinaryChild = delegated('delegated', 'worker');
		const input = projectionInput([chat('ordinary'), worker, ordinaryChild, chat('attention')], {
			workflows: workflows(),
		});
		const { rows, visibleChatIds, actionableChatIds } = buildSidebarRowModel(input);
		expect(visibleChatIds).toEqual(['worker', 'delegated', 'attention', 'ordinary']);
		expect(actionableChatIds).toEqual(visibleChatIds);
		expect(rows).toMatchObject([
			{ type: 'workflow-run', run, count: 3 },
			{ type: 'chat', chat: worker, depth: 1, tree: { isLastChild: false }, reorderScopeIds: [] },
			{ type: 'chat', chat: ordinaryChild, depth: 2, tree: { isLastChild: true } },
			{
				type: 'chat',
				chat: { id: 'attention', parentChatId: null },
				depth: 1,
				tree: { isLastChild: true },
			},
			{ type: 'chat', chat: { id: 'ordinary' }, depth: 0, branch: undefined },
		]);
		expect(worker.parentChatId).toBe('ordinary');
		expect(buildSidebarRowModel({ ...input, nestDelegatedChats: false }).rows[1]).toMatchObject({
			type: 'chat',
			chat: worker,
			depth: 1,
		});
	});

	it('keeps collapse and search independent while preserving matching descendants', () => {
		const input = projectionInput(
			[chat('worker'), delegated('match', 'worker'), chat('attention'), chat('ordinary')],
			{
				workflows: workflows({ collapsedRunIds: new Set([run.id]), moreRuns: true }),
			},
		);
		const collapsed = buildSidebarRowModel(input);
		expect(collapsed.visibleChatIds).toEqual(['ordinary']);
		expect(collapsed.rows[0]).toMatchObject({ type: 'workflow-run', isCollapsed: true });
		expect(collapsed.rows[1]).toMatchObject({ type: 'workflow-more', page: 'runs' });
		const filtered = buildSidebarRowModel({ ...input, matchingChatIds: new Set(['match']) });
		expect(filtered.visibleChatIds).toEqual(['worker', 'match']);
		expect(filtered.actionableChatIds).toEqual(['match']);
		expect(filtered.rows[0]).toMatchObject({ type: 'workflow-run', isCollapsed: false });
		expect(filtered.rows.some((row) => row.type === 'workflow-more')).toBe(false);
		expect(
			buildSidebarRowModel({ ...input, matchingChatIds: new Set(['ordinary']) }).rows,
		).toMatchObject([{ type: 'chat', chat: { id: 'ordinary' } }]);
	});
});
