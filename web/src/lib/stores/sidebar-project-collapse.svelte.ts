// Persists project collapse state separately from general local settings because
// project keys are dynamic and can grow with the user's chat history.

import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

export interface SidebarProjectCollapseSnapshot {
	collapsedProjectKeys: string[];
}

function uniqueStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const keys: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue;
		seen.add(item);
		keys.push(item);
	}
	return keys;
}

function parseSnapshot(value: unknown): SidebarProjectCollapseSnapshot {
	if (!value || typeof value !== 'object') return { collapsedProjectKeys: [] };
	return {
		collapsedProjectKeys: uniqueStringArray(
			(value as Partial<SidebarProjectCollapseSnapshot>).collapsedProjectKeys,
		),
	};
}

function readPersistedProjectCollapse(): SidebarProjectCollapseSnapshot {
	try {
		const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse);
		if (!raw) return { collapsedProjectKeys: [] };
		return parseSnapshot(JSON.parse(raw));
	} catch {
		return { collapsedProjectKeys: [] };
	}
}

function persistProjectCollapse(snapshot: SidebarProjectCollapseSnapshot): void {
	setLocalStorageItem(LOCAL_STORAGE_KEYS.sidebarProjectCollapse, JSON.stringify(snapshot));
}

function setsAreEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) {
		if (!right.has(value)) return false;
	}
	return true;
}

export class SidebarProjectCollapseStore {
	collapsedProjectKeys = $state<Set<string>>(new Set());

	#storageListener = (event: StorageEvent) => {
		if (event.key !== LOCAL_STORAGE_KEYS.sidebarProjectCollapse) return;
		this.#apply(readPersistedProjectCollapse());
	};

	constructor() {
		this.#apply(readPersistedProjectCollapse());
		if (typeof window !== 'undefined') {
			window.addEventListener('storage', this.#storageListener);
		}
	}

	destroy(): void {
		if (typeof window !== 'undefined') {
			window.removeEventListener('storage', this.#storageListener);
		}
	}

	isCollapsed(projectKey: string): boolean {
		return this.collapsedProjectKeys.has(projectKey);
	}

	setCollapsed(projectKey: string, collapsed: boolean): void {
		if (!projectKey) return;
		const next = new Set(this.collapsedProjectKeys);
		if (collapsed) next.add(projectKey);
		else next.delete(projectKey);
		this.#replaceAndPersist(next);
	}

	toggle(projectKey: string): void {
		this.setCollapsed(projectKey, !this.isCollapsed(projectKey));
	}

	pruneToProjectKeys(projectKeys: Iterable<string>): void {
		const allowed = new Set(projectKeys);
		const next = new Set<string>();
		for (const projectKey of this.collapsedProjectKeys) {
			if (allowed.has(projectKey)) next.add(projectKey);
		}
		this.#replaceAndPersist(next);
	}

	snapshot(): SidebarProjectCollapseSnapshot {
		return {
			collapsedProjectKeys: Array.from(this.collapsedProjectKeys).sort(),
		};
	}

	#apply(snapshot: SidebarProjectCollapseSnapshot): void {
		this.collapsedProjectKeys = new Set(snapshot.collapsedProjectKeys);
	}

	#replaceAndPersist(next: Set<string>): void {
		if (setsAreEqual(this.collapsedProjectKeys, next)) return;
		this.collapsedProjectKeys = next;
		persistProjectCollapse(this.snapshot());
	}
}

export function createSidebarProjectCollapseStore(): SidebarProjectCollapseStore {
	return new SidebarProjectCollapseStore();
}
