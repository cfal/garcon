import { afterEach, describe, expect, it, vi } from 'vitest';
import { sidebarFallbackDropInstruction, sidebarPointDropContext } from '../sidebar-drop-targets';
import { getSidebarChatDragData, type SidebarDropInstruction } from '../sidebar-pragmatic-dnd';
import { buildSidebarRowModel } from '$lib/sidebar/display/sidebar-row-model';
import { chat, delegated, projectionInput } from '$lib/sidebar/display/__tests__/sidebar-fixtures';

describe('branch drop fallback', () => {
	afterEach(() => vi.restoreAllMocks());
	const rows = buildSidebarRowModel(
		projectionInput([chat('a'), delegated('a1', 'a'), chat('b'), chat('c')]),
	).rows;
	const row = rows.find((row) => row.type === 'chat' && row.chat.id === 'b');
	if (row?.type !== 'chat') throw new Error('Missing branch row');
	const source = getSidebarChatDragData({
		chatId: 'b',
		list: 'normal',
		index: 2,
		instanceId: Symbol('sidebar'),
		reorderScopeKey: row.reorderScopeKey,
	});
	const previous: SidebarDropInstruction = {
		sourceChatId: 'b',
		sourceList: 'normal',
		sourceScopeKey: row.reorderScopeKey,
		targetChatId: 'a',
		targetList: 'normal',
		closestEdge: 'bottom',
	};
	function pointAt(chatId: string, drag = source, projectedRows = rows) {
		const target = projectedRows.find((row) => row.type === 'chat' && row.chat.id === chatId);
		if (target?.type !== 'chat') throw new Error('Missing target');
		const viewport = document.createElement('div');
		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 640));
		const element = document.createElement('div');
		element.dataset.sidebarVirtualRow = chatId;
		element.dataset.sidebarVirtualListRow = target.list;
		element.dataset.sidebarVirtualReorderScope = target.reorderScopeKey;
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(element);
		return sidebarPointDropContext(viewport, drag.instanceId, drag, 20, 20, projectedRows);
	}
	it.each(['context', 'cycle'])('blocks ineligible same-scope %s rows', (kind) => {
		const chats = [
			kind === 'cycle' ? delegated('a', 'a') : chat('a'),
			delegated('a1', 'a'), chat('b'), chat('c'),
		];
		const projected = buildSidebarRowModel(projectionInput(chats, {
			matchingChatIds: kind === 'context' ? new Set(['a1', 'b', 'c']) : undefined,
		})).rows;
		expect(pointAt('a', source, projected)).toEqual({ kind: 'blocked-row' });
	});
	it('resolves a descendant under the pointer to the end of its peer branch', () => {
		expect(pointAt('a1')).toEqual({ kind: 'compatible-row', instruction: previous });
	});
	it('treats the source subtree as the source, not another reorder target', () => {
		expect(pointAt('a1', { ...source, chatId: 'a' })).toEqual({ kind: 'source-row' });
	});
	it('never promotes child drags to a different parent scope', () => {
		const child = rows.find((row) => row.type === 'chat' && row.chat.id === 'a1');
		if (child?.type !== 'chat') throw new Error('Missing child');
		expect(
			pointAt('b', { ...source, chatId: 'a1', reorderScopeKey: child.reorderScopeKey }),
		).toEqual({ kind: 'blocked-row' });
	});
	it('uses peer adjacency despite intervening descendants', () => {
		expect(sidebarFallbackDropInstruction(source, { kind: 'source-row' }, previous, rows)).toBe(
			previous,
		);
	});
	it.each(['blocked-row', 'blocked-item', 'outside'] as const)(
		'never reuses a target over %s',
		(kind) => {
			expect(sidebarFallbackDropInstruction(source, { kind }, previous, rows)).toBeNull();
		},
	);
	it('rejects an obsolete source or edge', () => {
		expect(
			sidebarFallbackDropInstruction(
				source,
				{ kind: 'source-row' },
				{ ...previous, closestEdge: 'top' },
				rows,
			),
		).toBeNull();
		expect(
			sidebarFallbackDropInstruction(
				source,
				{ kind: 'empty' },
				{ ...previous, sourceChatId: 'c' },
				rows,
			),
		).toBeNull();
	});
});
