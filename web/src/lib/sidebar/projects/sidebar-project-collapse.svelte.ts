// Persists project collapse state separately from general local settings because
// project keys are dynamic and can grow with the user's chat history.

import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import { effectiveExecutorId } from '$shared/executors';
import { sidebarProjectKey } from '../display/sidebar-row-model';
import { SIDEBAR_GROUPING_FIELDS } from '../display/sidebar-preferences';

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

	pruneToRoster(chats: readonly ChatSessionRecord[]): void {
		const ids = new Set(chats.map((chat) => chat.id));
		const executors = new Set(chats.map((chat) => effectiveExecutorId(chat.executorId)));
		const projects = new Set(
			chats.map((chat) => sidebarProjectKey(chat.projectPath, chat.executorId)),
		);
		const activitySections = new Set(['active', 'inactive', 'archived']);
		const statusSections = new Set(['in-progress', 'ready-for-review', 'caught-up']);
		const retainedKeys = [...this.collapsedProjectKeys].filter((key) => {
			if (key.startsWith('delegation:')) return ids.has(key.slice('delegation:'.length));
			if (!key.startsWith('group:')) return false;
			try {
				const value: unknown = JSON.parse(key.slice('group:'.length));
				if (!Array.isArray(value) || value.length !== 2) return false;
				const [parent, path] = value;
				if (parent !== null && !ids.has(parent)) return false;
				if (
					!Array.isArray(path) ||
					path.length === 0 ||
					path.length > SIDEBAR_GROUPING_FIELDS.length
				)
					return false;
				const fields = new Set<string>();
				return path.every((pair) => {
					if (!Array.isArray(pair) || pair.length !== 2) return false;
					const [field, entry] = pair;
					if (typeof field !== 'string' || fields.has(field)) return false;
					fields.add(field);
					switch (field) {
						case 'executor':
							return executors.has(entry);
						case 'project':
							return projects.has(entry);
						case 'activity':
							return activitySections.has(entry);
						case 'status':
							return statusSections.has(entry);
						default:
							return false;
					}
				});
			} catch {
				return false;
			}
		});
		this.#replaceAndPersist(new Set(retainedKeys));
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
