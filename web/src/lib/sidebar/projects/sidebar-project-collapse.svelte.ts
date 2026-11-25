// Persists project collapse state separately from general local settings because
// project keys are dynamic and can grow with the user's chat history.

import {
	LOCAL_STORAGE_KEYS,
	getLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import { effectiveExecutorId } from '$shared/executors';
import { isRecord } from '$shared/json';
import { sidebarProjectKey } from '../display/sidebar-row-model';
import { DELEGATION_KEY_PREFIX, isSidebarKeyCollapsed } from '../display/sidebar-collapse';

export interface SidebarProjectCollapseSnapshot {
	collapsedProjectKeys: string[];
	expandedDelegationKeys: string[];
}

function nonEmptyStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((key): key is string => typeof key === 'string' && key.length > 0);
}

const storageKey = LOCAL_STORAGE_KEYS.sidebarProjectCollapse;

function parseProjectCollapse(raw: string | null): Record<string, unknown> {
	try {
		const saved: unknown = raw ? JSON.parse(raw) : null;
		return isRecord(saved) ? saved : {};
	} catch {
		return {};
	}
}

function setsAreEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
	if (left === right) return true;
	if (left.size !== right.size) return false;
	for (const value of left) {
		if (!right.has(value)) return false;
	}
	return true;
}

function isCurrentGroupKey(
	key: string,
	chatIds: ReadonlySet<string>,
	entriesByField: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
	if (!key.startsWith('group:')) return false;
	let group: unknown;
	try {
		group = JSON.parse(key.slice('group:'.length));
	} catch {
		return false;
	}
	if (!Array.isArray(group) || group.length !== 2) return false;
	const [parentId, path] = group;
	if (parentId !== null && !chatIds.has(parentId)) return false;
	if (!Array.isArray(path) || path.length === 0 || path.length > entriesByField.size) return false;

	const seenFields = new Set<string>();
	for (const pair of path) {
		if (!Array.isArray(pair) || pair.length !== 2) return false;
		const [field, entry] = pair;
		if (seenFields.has(field) || !entriesByField.get(field)?.has(entry)) return false;
		seenFields.add(field);
	}
	return true;
}

export class SidebarProjectCollapseStore {
	collapsedProjectKeys = $state.raw<Set<string>>(new Set());
	expandedDelegationKeys = $state.raw<Set<string>>(new Set());
	#lastPrune:
		| {
				keys: ReadonlySet<string>;
				chats: ReadonlyMap<string, Pick<ChatSessionRecord, 'projectPath' | 'executorId'>>;
		  }
		| undefined;
	#storageListener = (event: StorageEvent) => {
		if (event.key !== null && event.key !== storageKey) return;
		if (event.storageArea === window.localStorage) this.#restore();
	};

	constructor() {
		this.#restore();
		if (typeof window !== 'undefined') {
			window.addEventListener('storage', this.#storageListener);
		}
	}

	destroy(): void {
		if (typeof window !== 'undefined') {
			window.removeEventListener('storage', this.#storageListener);
		}
	}

	isCollapsed(key: string, collapseDelegatedChatsByDefault?: boolean): boolean {
		return isSidebarKeyCollapsed(key, this, collapseDelegatedChatsByDefault);
	}

	setCollapsed(key: string, collapsed: boolean): void {
		if (!key) return;
		const nextCollapsed = new Set(this.collapsedProjectKeys);
		if (collapsed) nextCollapsed.add(key);
		else nextCollapsed.delete(key);
		let nextExpanded = this.expandedDelegationKeys;
		if (key.startsWith(DELEGATION_KEY_PREFIX)) {
			nextExpanded = new Set(nextExpanded);
			if (collapsed) nextExpanded.delete(key);
			else nextExpanded.add(key);
		}
		this.#replaceChoices(nextCollapsed, nextExpanded);
	}

	toggle(key: string, collapseDelegatedChatsByDefault?: boolean): void {
		this.setCollapsed(key, !this.isCollapsed(key, collapseDelegatedChatsByDefault));
	}

	forgetDeletedChat(chatId: string): void {
		const key = DELEGATION_KEY_PREFIX + chatId;
		if (!this.collapsedProjectKeys.has(key) && !this.expandedDelegationKeys.has(key)) return;
		const collapsed = new Set(this.collapsedProjectKeys);
		const expanded = new Set(this.expandedDelegationKeys);
		collapsed.delete(key);
		expanded.delete(key);
		this.#replaceChoices(collapsed, expanded);
	}

	pruneGroupChoices(chats: readonly ChatSessionRecord[]): void {
		const previous = this.#lastPrune;
		if (
			previous?.keys === this.collapsedProjectKeys &&
			previous.chats.size === chats.length &&
			chats.every((chat) => {
				const old = previous.chats.get(chat.id);
				return old && old.projectPath === chat.projectPath && old.executorId === chat.executorId;
			})
		)
			return;
		const keys = [...this.collapsedProjectKeys];
		if (keys.every((key) => key.startsWith(DELEGATION_KEY_PREFIX))) return;
		const chatIds = new Set(chats.map((chat) => chat.id));
		const entriesByField = new Map<string, ReadonlySet<string>>([
			['executor', new Set(chats.map((chat) => effectiveExecutorId(chat.executorId)))],
			[
				'project',
				new Set(chats.map((chat) => sidebarProjectKey(chat.projectPath, chat.executorId))),
			],
			['activity', new Set(['active', 'inactive', 'archived'])],
			['status', new Set(['in-progress', 'ready-for-review', 'caught-up'])],
		]);
		const retained = keys.filter(
			(key) =>
				key.startsWith(DELEGATION_KEY_PREFIX) || isCurrentGroupKey(key, chatIds, entriesByField),
		);
		this.#replaceChoices(new Set(retained), this.expandedDelegationKeys);
		this.#lastPrune = {
			keys: this.collapsedProjectKeys,
			chats: new Map(
				chats.map(({ id, projectPath, executorId }) => [id, { projectPath, executorId }]),
			),
		};
	}

	snapshot(): SidebarProjectCollapseSnapshot {
		return {
			collapsedProjectKeys: Array.from(this.collapsedProjectKeys).sort(),
			expandedDelegationKeys: Array.from(this.expandedDelegationKeys).sort(),
		};
	}

	#restore(): void {
		const saved = parseProjectCollapse(getLocalStorageItem(storageKey));
		this.collapsedProjectKeys = new Set(nonEmptyStrings(saved.collapsedProjectKeys));
		this.expandedDelegationKeys = new Set(
			nonEmptyStrings(saved.expandedDelegationKeys).filter((key) =>
				key.startsWith(DELEGATION_KEY_PREFIX),
			),
		);
	}

	#replaceChoices(collapsed: Set<string>, expanded: Set<string>): void {
		if (
			setsAreEqual(this.collapsedProjectKeys, collapsed) &&
			setsAreEqual(this.expandedDelegationKeys, expanded)
		) {
			return;
		}
		this.collapsedProjectKeys = collapsed;
		this.expandedDelegationKeys = expanded;
		setLocalStorageItem(storageKey, JSON.stringify(this.snapshot()));
	}
}

export function createSidebarProjectCollapseStore(): SidebarProjectCollapseStore {
	return new SidebarProjectCollapseStore();
}
