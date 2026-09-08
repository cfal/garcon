import { describe, expect, it } from 'vitest';
import {
	mountedElementForScrollTarget,
	sidebarScrollTargetForChat,
} from '../sidebar-chat-list-dom';
import { sidebarProjectKey } from '../sidebar-row-model';
import {
	sidebarSectionKey,
	sidebarSectionProjectKey,
	type SidebarVirtualRow,
} from '../sidebar-virtual-chat-list';

describe('sidebar chat scroll targets', () => {
	it('anchors a collapsed inactive project instead of its duplicate active or section header', () => {
		const projectKey = sidebarProjectKey('/tmp/shared-project');
		const inactiveProjectCollapseKey = sidebarSectionProjectKey('inactive', projectKey);
		const rows: SidebarVirtualRow[] = [
			{
				type: 'project-header',
				key: `project:${projectKey}`,
				projectKey,
				collapseKey: projectKey,
				projectPath: '/tmp/shared-project',
				count: 1,
				chatIds: ['active-chat'],
				isCollapsed: false,
			},
			{
				type: 'section-header',
				key: sidebarSectionKey('inactive'),
				section: 'inactive',
				count: 1,
				chatIds: ['inactive-chat'],
				isCollapsed: false,
			},
			{
				type: 'project-header',
				key: `project:${inactiveProjectCollapseKey}`,
				projectKey,
				collapseKey: inactiveProjectCollapseKey,
				projectPath: '/tmp/shared-project',
				count: 1,
				chatIds: ['inactive-chat'],
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
