import { setLocalStorageWithCacheRecovery } from './local-storage-cache-recovery';

type ValueOf<T> = T[keyof T];

export const LOCAL_STORAGE_KEYS = {
	authToken: 'bearer-token',
	composerHeight: 'composerHeight',
	fileTreeFoldersFirst: 'file-tree-folders-first',
	fileTreeShowHiddenFiles: 'file-tree-show-hidden-files',
	fileTreeSortDirection: 'file-tree-sort-direction',
	fileTreeSortKey: 'file-tree-sort-key',
	gitHideOtherTabFiles: 'git.hideOtherTabFiles',
	gitTreePaneWidthPx: 'git.treePaneWidthPx',
	justRegistered: 'just-registered',
	localSettings: 'pref_local_settings',
	modelCatalog: 'pref_model_catalog_v3',
	modelCatalogLegacy: 'pref_model_catalog_v2',
	sidebarProjectCollapse: 'pref_sidebar_project_collapse',
	workspaceLayout: 'workspace_layout_v1',
} as const;

export const LOCAL_STORAGE_PREFIXES = {
	chatDraft: 'chat_draft_',
} as const;

export const SESSION_STORAGE_KEYS = {
	pendingChatId: 'pendingChatId',
	terminalClientId: 'terminal_client_id_v1',
	terminalLauncherDismissed: 'terminal_launcher_dismissed_v1',
} as const;

export type ChatDraftStorageKey = `${typeof LOCAL_STORAGE_PREFIXES.chatDraft}${string}`;
export type LocalStorageKey = ValueOf<typeof LOCAL_STORAGE_KEYS> | ChatDraftStorageKey;
export type SessionStorageKey = ValueOf<typeof SESSION_STORAGE_KEYS>;

type BrowserStorageKind = 'local' | 'session';

function getBrowserStorage(kind: BrowserStorageKind): Storage | null {
	try {
		return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
	} catch {
		return null;
	}
}

export function chatDraftStorageKey(chatId: string): ChatDraftStorageKey {
	return `${LOCAL_STORAGE_PREFIXES.chatDraft}${chatId}`;
}

export function getLocalStorageItem(key: LocalStorageKey): string | null {
	try {
		return getBrowserStorage('local')?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

export function setLocalStorageItem(key: LocalStorageKey, value: string): void {
	try {
		const storage = getBrowserStorage('local');
		if (storage) setLocalStorageWithCacheRecovery(storage, key, value);
	} catch {
		/* localStorage unavailable */
	}
}

export function removeLocalStorageItem(key: LocalStorageKey): void {
	try {
		getBrowserStorage('local')?.removeItem(key);
	} catch {
		/* localStorage unavailable */
	}
}

export function getSessionStorageItem(key: SessionStorageKey): string | null {
	try {
		return getBrowserStorage('session')?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

export function setSessionStorageItem(key: SessionStorageKey, value: string): void {
	try {
		getBrowserStorage('session')?.setItem(key, value);
	} catch {
		/* sessionStorage unavailable */
	}
}

export function removeSessionStorageItem(key: SessionStorageKey): void {
	try {
		getBrowserStorage('session')?.removeItem(key);
	} catch {
		/* sessionStorage unavailable */
	}
}
