import { describe, expect, it } from 'vitest';
import {
	mountedElementForScrollTarget,
	sidebarScrollTargetForChat,
} from '../sidebar-chat-list-dom';
import {
	sidebarProjectKey,
	sidebarGroupCollapseKey,
	buildSidebarRowModel,
} from '../../../sidebar/display/sidebar-row-model';
import { type SidebarVirtualRow } from '../../../sidebar/display/sidebar-virtual-chat-list';
import { chat, delegated, projectionInput } from '$lib/sidebar/display/__tests__/sidebar-fixtures';

describe('sidebar chat scroll targets', () => {
	it.each([
		['executor', 'executorCollapseKey'],
		['project', 'projectCollapseKey'],
		['activity', 'sectionKey'],
		['status', 'sectionKey'],
	] as const)('anchors a delegated descendant in a collapsed %s group', (field, targetKey) => {
		const input = projectionInput(
			[chat('root'), delegated('child', 'root'), delegated('grandchild', 'child')],
			{ groupingFields: [{ field, enabled: true }] },
		);
		const header = buildSidebarRowModel(input).rows[0];
		const { rows } = buildSidebarRowModel({
			...input,
			collapsedProjectKeys: new Set([header.key]),
		});
		expect(rows).toHaveLength(1);
		expect(sidebarScrollTargetForChat(rows, 'grandchild')).toEqual({
			index: 0,
			[targetKey]: header.key,
		});
		expect(sidebarScrollTargetForChat(rows, 'missing')).toBeNull();
	});

	it.each([false, true])(
		'anchors the closest visible collapsed ancestor with executor collapsed=%s',
		(isCollapsed) => {
			const rows: SidebarVirtualRow[] = [
				{
					type: 'executor-header',
					key: 'executor:worker',
					depth: 0,
					collapseKey: 'executor:worker',
					executorId: 'worker',
					count: 1,
					containsChat: (chatId) => chatId === 'hidden',
					isCollapsed,
				},
			];
			const sectionKey = sidebarGroupCollapseKey(null, [
				['executor', 'worker'],
				['activity', 'inactive'],
			]);
			if (!isCollapsed)
				rows.push({
					type: 'section-header',
					key: sectionKey,
					depth: 1,
					section: 'inactive',
					count: 1,
					containsChat: (chatId) => chatId === 'hidden',
					isCollapsed: true,
				});
			const target = sidebarScrollTargetForChat(rows, 'hidden');
			expect(target).toEqual(
				isCollapsed
					? { index: 0, executorCollapseKey: 'executor:worker' }
					: { index: 1, sectionKey },
			);
			const viewport = document.createElement('div');
			const executor = document.createElement('button');
			executor.dataset.sidebarExecutorCollapseKey = 'executor:worker';
			const section = document.createElement('button');
			section.dataset.sidebarSectionKey = sectionKey;
			viewport.append(executor, section);
			expect(target && mountedElementForScrollTarget(viewport, target)).toBe(
				isCollapsed ? executor : section,
			);
		},
	);

	it('anchors a collapsed inactive project instead of its duplicate active or section header', () => {
		const projectKey = sidebarProjectKey('/tmp/shared-project');
		const inactiveProjectCollapseKey = sidebarGroupCollapseKey(null, [
			['activity', 'inactive'],
			['project', projectKey],
		]);
		const rows: SidebarVirtualRow[] = [
			{
				type: 'project-header',
				key: `project:${projectKey}`,
				depth: 0,
				projectKey,
				collapseKey: projectKey,
				projectPath: '/tmp/shared-project',
				count: 1,
				containsChat: (chatId) => chatId === 'active-chat',
				isCollapsed: false,
			},
			{
				type: 'section-header',
				key: sidebarGroupCollapseKey(null, [['activity', 'inactive']]),
				depth: 0,
				section: 'inactive',
				count: 1,
				containsChat: (chatId) => chatId === 'inactive-chat',
				isCollapsed: false,
			},
			{
				type: 'project-header',
				key: `project:${inactiveProjectCollapseKey}`,
				depth: 0,
				projectKey,
				collapseKey: inactiveProjectCollapseKey,
				projectPath: '/tmp/shared-project',
				count: 1,
				containsChat: (chatId) => chatId === 'inactive-chat',
				isCollapsed: true,
			},
		];

		const target = sidebarScrollTargetForChat(rows, 'inactive-chat');
		expect(target).toEqual({ index: 2, projectCollapseKey: inactiveProjectCollapseKey });

		const viewport = document.createElement('div');
		const activeHeader = document.createElement('div');
		activeHeader.dataset.sidebarProjectCollapseKey = projectKey;
		const inactiveHeader = document.createElement('div');
		inactiveHeader.dataset.sidebarProjectCollapseKey = inactiveProjectCollapseKey;
		viewport.append(activeHeader, inactiveHeader);

		expect(target && mountedElementForScrollTarget(viewport, target)).toBe(inactiveHeader);
	});
});
