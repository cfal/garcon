import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSidebarProjectCollapseStore } from '$lib/sidebar/projects/sidebar-project-collapse.svelte.js';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import { chat, delegated } from '$lib/sidebar/display/__tests__/sidebar-fixtures';
import { sidebarGroupCollapseKey, sidebarProjectKey } from '$lib/sidebar/display/sidebar-row-model';

const storageKey = LOCAL_STORAGE_KEYS.sidebarProjectCollapse;

function createTestStore() {
	const store = createSidebarProjectCollapseStore();
	onTestFinished(() => store.destroy());
	return store;
}

describe('SidebarProjectCollapseStore', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('defaults to no collapsed projects', () => {
		const store = createTestStore();

		expect(store.snapshot()).toEqual({ collapsedProjectKeys: [], expandedDelegationKeys: [] });
	});

	it('retains a project collapse when only an equivalent path spelling remains', () => {
		const store = createTestStore();
		const key = sidebarGroupCollapseKey(null, [['project', sidebarProjectKey('/repo/')]]);
		store.setCollapsed(key, true);
		store.pruneGroupChoices([chat('remaining', { projectPath: '/repo' })]);
		expect(store.isCollapsed(key)).toBe(true);
	});

	it('prunes stale groups and legacy keys without touching branch choices', () => {
		const store = createTestStore();
		const roster = [chat('parent'), delegated('child', 'parent')];
		const group = sidebarGroupCollapseKey('parent', [
			['executor', 'local'],
			['project', sidebarProjectKey(roster[1].projectPath)],
			['activity', 'active'],
			['status', 'ready-for-review'],
		]);
		for (const key of [
			'delegation:parent',
			group,
			'delegation:deleted',
			'path:/old',
			'group:invalid',
			sidebarGroupCollapseKey(null, [['status', 'active']]),
			sidebarGroupCollapseKey(null, [
				['activity', 'active'],
				['activity', 'active'],
			]),
		]) {
			store.setCollapsed(key, true);
		}
		store.pruneGroupChoices(roster);
		expect(store.collapsedProjectKeys).toEqual(
			new Set(['delegation:parent', 'delegation:deleted', group]),
		);
		store.pruneGroupChoices([roster[1]]);
		expect(store.collapsedProjectKeys.has(group)).toBe(false);
		expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
			collapsedProjectKeys: ['delegation:deleted', 'delegation:parent'],
			expandedDelegationKeys: [],
		});
	});

	it('persists collapsed project keys', () => {
		const store = createTestStore();

		store.setCollapsed('path:/workspace/a', true);
		store.setCollapsed('path:/workspace/b', true);
		store.setCollapsed('path:/workspace/a', false);

		expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
			collapsedProjectKeys: ['path:/workspace/b'],
			expandedDelegationKeys: [],
		});
	});

	it('keeps manual choices in memory when browser storage cannot be written', () => {
		const store = createTestStore();
		store.setCollapsed('delegation:existing', true);
		const initial = localStorage.getItem(storageKey);
		const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new DOMException('Quota exceeded', 'QuotaExceededError');
		});
		onTestFinished(() => write.mockRestore());
		store.setCollapsed('delegation:parent', false);
		store.setCollapsed('delegation:other', true);
		expect(store.snapshot()).toEqual({
			collapsedProjectKeys: ['delegation:existing', 'delegation:other'],
			expandedDelegationKeys: ['delegation:parent'],
		});
		expect(localStorage.getItem(storageKey)).toBe(initial);
	});

	it('syncs collapsed project keys across storage events', () => {
		const firstStore = createTestStore();
		const secondStore = createTestStore();

		localStorage.setItem(
			storageKey,
			JSON.stringify({
				collapsedProjectKeys: ['path:/workspace/synced', '', null, 'path:/workspace/synced'],
				expandedDelegationKeys: ['delegation:synced', 'group:unused', 'delegation:synced'],
			}),
		);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: storageKey,
				storageArea: localStorage,
				newValue: localStorage.getItem(storageKey),
			}),
		);

		expect(firstStore.isCollapsed('path:/workspace/synced')).toBe(true);
		expect(secondStore.isCollapsed('path:/workspace/synced')).toBe(true);
		expect(secondStore.isCollapsed('delegation:synced', true)).toBe(false);
		expect(secondStore.snapshot()).toEqual({
			collapsedProjectKeys: ['path:/workspace/synced'],
			expandedDelegationKeys: ['delegation:synced'],
		});
	});

	it('ignores session storage and restores defaults on local storage clear', () => {
		const store = createTestStore();
		store.setCollapsed('delegation:parent', true);
		localStorage.clear();
		window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key: null }));
		expect(store.isCollapsed('delegation:parent')).toBe(true);
		window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: null }));
		expect(store.isCollapsed('delegation:parent')).toBe(false);
	});

	it('restores explicit branch choices independently of the current default', () => {
		const key = 'delegation:parent';
		localStorage.setItem(storageKey, JSON.stringify({ collapsedProjectKeys: [key] }));
		const store = createTestStore();
		expect(store.isCollapsed(key, false)).toBe(true);
		store.toggle(key, false);
		const restored = createTestStore();
		expect(restored.isCollapsed(key, true)).toBe(false);
		expect(restored.isCollapsed('delegation:untouched', true)).toBe(true);
		expect(restored.isCollapsed('delegation:untouched', false)).toBe(false);
		expect(restored.isCollapsed('group:untouched', true)).toBe(false);
		restored.toggle(key, true);
		expect(restored.isCollapsed(key, false)).toBe(true);
		expect(restored.expandedDelegationKeys.size).toBe(0);
	});
});
