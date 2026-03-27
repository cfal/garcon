// Manages sidebar filtering state: search query, selected folder,
// and the derived filtered chat list. Composes folder filter and
// search query with AND semantics.

import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatFolder } from '$lib/api/settings';
import { parseChatSearch, matchesChatFilter, isEmptyFilter, type ChatFilterSpec } from './sidebar-search';

export type SystemFolderId = 'all' | 'active' | 'unread';

export interface FolderEntry {
	id: string;
	name: string;
	isSystem: boolean;
	filter: ChatFilterSpec | null;
}

const SYSTEM_FOLDERS: FolderEntry[] = [
	{ id: 'all', name: 'All', isSystem: true, filter: null },
	{ id: 'active', name: 'Active', isSystem: true, filter: null },
	{ id: 'unread', name: 'Unread', isSystem: true, filter: null },
];

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
		const user: FolderEntry[] = this.userFolders.map((f) => ({
			id: f.id,
			name: f.name,
			isSystem: false,
			filter: f.filter as ChatFilterSpec,
		}));
		return [...SYSTEM_FOLDERS, ...user];
	}

	get selectedFolder(): FolderEntry {
		return this.folders.find((f) => f.id === this.selectedFolderId) ?? SYSTEM_FOLDERS[0];
	}

	get filteredChats(): ChatSessionRecord[] {
		const chats = this.#getChats();
		const search = this.parsedSearch;
		const folder = this.selectedFolder;

		let result = chats;

		// Apply system folder filter
		if (folder.id === 'active') {
			result = result.filter((c) => c.isProcessing);
		} else if (folder.id === 'unread') {
			result = result.filter((c) => c.isUnread);
		} else if (!folder.isSystem && folder.filter) {
			result = result.filter((c) => matchesChatFilter(c, folder.filter!));
		}

		// Apply search filter
		if (!isEmptyFilter(search)) {
			result = result.filter((c) => matchesChatFilter(c, search));
		}

		return result;
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
