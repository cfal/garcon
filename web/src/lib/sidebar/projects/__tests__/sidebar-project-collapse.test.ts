import { beforeEach, describe, expect, it } from 'vitest';
import { createSidebarProjectCollapseStore } from '$lib/sidebar/projects/sidebar-project-collapse.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

describe('SidebarProjectCollapseStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults to no collapsed projects', () => {
		const store = createSidebarProjectCollapseStore();

		expect(store.snapshot()).toEqual({ collapsedProjectKeys: [] });

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

	it('prunes stale project keys', () => {
		const store = createSidebarProjectCollapseStore();

		store.setCollapsed('path:/workspace/a', true);
		store.setCollapsed('path:/workspace/b', true);
		store.pruneToProjectKeys(['path:/workspace/b']);

		expect(store.snapshot()).toEqual({ collapsedProjectKeys: ['path:/workspace/b'] });

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
