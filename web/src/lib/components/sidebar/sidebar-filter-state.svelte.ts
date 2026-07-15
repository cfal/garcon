// Manages sidebar filtering state: search query, selected folder,
// and the derived filtered chat list. Composes folder filter and
// search query with AND semantics.

import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatFolder } from '$lib/api/settings';
import * as m from '$lib/paraglide/messages.js';
import {
	emptyFilterSpec,
	parseChatSearch,
	matchesChatFilter,
	isEmptyFilter,
	type ChatFilterSpec,
} from '$lib/sidebar/search/sidebar-search.js';
import { compareChatsByRecencyDesc } from './chat-recency-sort';

export type SystemFolderId = 'all' | 'active' | 'unread';

export interface FolderEntry {
	id: string;
	name: string;
	isSystem: boolean;
	filter: ChatFilterSpec | null;
}

function getSystemFolders(): FolderEntry[] {
	return [
		{ id: 'all', name: m.sidebar_folders_system_all(), isSystem: true, filter: null },
		{
			id: 'active',
			name: m.sidebar_folders_system_active(),
			isSystem: true,
			filter: { ...emptyFilterSpec(), status: 'active' },
		},
		{
			id: 'unread',
			name: m.sidebar_folders_system_unread(),
			isSystem: true,
			filter: { ...emptyFilterSpec(), status: 'unread' },
		},
	];
}

function mergeChatFilters(base: ChatFilterSpec | null, search: ChatFilterSpec): ChatFilterSpec {
	const merged = emptyFilterSpec();
	merged.textTokens = Array.from(new Set([...(base?.textTokens ?? []), ...search.textTokens]));
	merged.tags = mergeTagGroups(base?.tags, search.tags);
	merged.agents = Array.from(new Set([...(base?.agents ?? []), ...search.agents]));
	merged.models = Array.from(new Set([...(base?.models ?? []), ...search.models]));
	merged.project = Array.from(new Set([...(base?.project ?? []), ...search.project]));
	merged.status = base?.status;
	return merged;
}

function mergeTagGroups(a: string[][] | undefined, b: string[][]): string[][] {
	const seen = new Set<string>();
	const result: string[][] = [];
	for (const group of [...(a ?? []), ...b]) {
		const key = group.join(',');
		if (!seen.has(key)) {
			seen.add(key);
			result.push(group);
		}
	}
	return result;
}

export class SidebarFilterState {
	searchQuery = $state('');
	selectedFolderId = $state<string>('all');
	userFolders = $state<ChatFolder[]>([]);

	#getChats: () => ChatSessionRecord[];

	constructor(deps: { get chats(): ChatSessionRecord[] }) {
		this.#getChats = () => deps.chats;
	}

	get parsedSearch(): ChatFilterSpec {
		return parseChatSearch(this.searchQuery);
	}

	get folders(): FolderEntry[] {
		const systemFolders = getSystemFolders();
		const user: FolderEntry[] = this.userFolders.map((f) => ({
			id: f.id,
			name: f.name,
			isSystem: false,
			filter: f.filter as ChatFilterSpec,
		}));
		return [...systemFolders, ...user];
	}

	get selectedFolder(): FolderEntry {
		return this.folders.find((f) => f.id === this.selectedFolderId) ?? getSystemFolders()[0];
	}

	get currentFilter(): ChatFilterSpec {
		return mergeChatFilters(this.selectedFolder.filter, this.parsedSearch);
	}

	get canSaveCurrentFilter(): boolean {
		return !isEmptyFilter(this.currentFilter);
	}

	get filteredChats(): ChatSessionRecord[] {
		const chats = this.#getChats();
		const filter = this.currentFilter;
		const result = isEmptyFilter(filter)
			? [...chats]
			: chats.filter((chat) => matchesChatFilter(chat, filter));
		return result.sort(compareChatsByRecencyDesc);
	}

	get allKnownTags(): string[] {
		const chats = this.#getChats();
		return Array.from(new Set(chats.flatMap((c) => c.tags))).sort();
	}

	get isFiltered(): boolean {
		return this.selectedFolderId !== 'all' || this.searchQuery.trim().length > 0;
	}

	selectFolder(id: string): void {
		this.selectedFolderId = id;
	}

	setUserFolders(folders: ChatFolder[]): void {
		this.userFolders = folders;
	}
}
