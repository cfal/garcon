import { beforeEach, describe, expect, it } from 'vitest';
import { createSidebarProjectCollapseStore } from '$lib/sidebar/projects/sidebar-project-collapse.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import { chat, delegated } from '$lib/sidebar/display/__tests__/sidebar-fixtures';
import { sidebarGroupCollapseKey, sidebarProjectKey } from '$lib/sidebar/display/sidebar-row-model';

describe('SidebarProjectCollapseStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults to no collapsed projects', () => {
		const store = createSidebarProjectCollapseStore();

		expect(store.snapshot()).toEqual({ collapsedProjectKeys: [] });

		store.destroy();
	});
	it('retains a project collapse when only an equivalent path spelling remains', () => {
		const store = createSidebarProjectCollapseStore();
		const key = sidebarGroupCollapseKey(null, [['project', sidebarProjectKey('/repo/')]]);
		store.setCollapsed(key, true);
		store.pruneToRoster([chat('remaining', { projectPath: '/repo' })]);
		expect(store.isCollapsed(key)).toBe(true);
		store.destroy();
	});

	it('retains hidden branch scopes against the full roster and retires deleted identities and old keys', () => {
		const store = createSidebarProjectCollapseStore();
		const roster = [chat('parent'), delegated('child', 'parent')];
		const group = sidebarGroupCollapseKey('parent', [
			['project', sidebarProjectKey(roster[1].projectPath)],
		]);
		for (const key of [
			'delegation:parent',
			group,
			'delegation:deleted',
			'path:/old',
			'group:invalid',
			sidebarGroupCollapseKey(null, [['status', 'active']]),
		])
			store.setCollapsed(key, true);
		store.pruneToRoster(roster);
		expect(store.collapsedProjectKeys).toEqual(new Set(['delegation:parent', group]));
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse) ?? '{}'),
		).toEqual({ collapsedProjectKeys: ['delegation:parent', group] });
		store.pruneToRoster([roster[1]]);
		expect(store.collapsedProjectKeys.size).toBe(0);
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse) ?? '{}'),
		).toEqual({ collapsedProjectKeys: [] });
		store.destroy();
	});

	it('persists collapsed project keys', () => {
		const store = createSidebarProjectCollapseStore();

		store.setCollapsed('path:/workspace/a', true);
		store.setCollapsed('path:/workspace/b', true);
		store.setCollapsed('path:/workspace/a', false);

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse) ?? '{}'),
		).toEqual({
			collapsedProjectKeys: ['path:/workspace/b'],
		});

		store.destroy();
	});

	it('syncs collapsed project keys across storage events', () => {
		const firstStore = createSidebarProjectCollapseStore();
		const secondStore = createSidebarProjectCollapseStore();

		localStorage.setItem(
			LOCAL_STORAGE_KEYS.sidebarProjectCollapse,
			JSON.stringify({ collapsedProjectKeys: ['path:/workspace/synced'] }),
		);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: LOCAL_STORAGE_KEYS.sidebarProjectCollapse,
				newValue: localStorage.getItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse),
			}),
		);

		expect(firstStore.isCollapsed('path:/workspace/synced')).toBe(true);
		expect(secondStore.isCollapsed('path:/workspace/synced')).toBe(true);

		firstStore.destroy();
		secondStore.destroy();
	});
});
