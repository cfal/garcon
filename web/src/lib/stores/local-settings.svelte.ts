// Reactive local settings store using Svelte 5 runes. Persists
// browser-only preferences to persisted storage.

import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

export type ThemeMode = 'dark' | 'light' | 'system';
export const CHAT_MAX_WIDTH_VALUES = ['none', 'large', 'medium', 'small'] as const;
export type ChatMaxWidth = (typeof CHAT_MAX_WIDTH_VALUES)[number];

export interface LocalSettingsSnapshot {
	theme: ThemeMode;
	colorblindMode: boolean;
	autoExpandTools: boolean;
	showThinking: boolean;
	showQuickCommitTray: boolean;
	autoScrollToBottom: boolean;
	sendByShiftEnter: boolean;
	chatMaxWidth: ChatMaxWidth;
	alwaysFullscreenOnGitPanel: boolean;
	sidebarVisible: boolean;
	sidebarWidth: number;
	sidebarGroupByProject: boolean;
	sidebarCompactChatItems: boolean;
	codeEditorTheme: string;
	codeEditorWordWrap: boolean;
	codeEditorLineNumbers: boolean;
	codeEditorFontSize: string;
	gitDiffFontSize: string;
	markdownViewerFontSize: string;
	language: string;
}

type BooleanLocalSettingKey =
	| 'colorblindMode'
	| 'autoExpandTools'
	| 'showThinking'
	| 'showQuickCommitTray'
	| 'autoScrollToBottom'
	| 'sendByShiftEnter'
	| 'alwaysFullscreenOnGitPanel'
	| 'sidebarVisible'
	| 'sidebarGroupByProject'
	| 'sidebarCompactChatItems'
	| 'codeEditorWordWrap'
	| 'codeEditorLineNumbers';

const DEFAULTS: LocalSettingsSnapshot = {
	theme: 'system',
	colorblindMode: false,
	autoExpandTools: false,
	showThinking: true,
	showQuickCommitTray: true,
	autoScrollToBottom: true,
	sendByShiftEnter: false,
	chatMaxWidth: 'none',
	alwaysFullscreenOnGitPanel: true,
	sidebarVisible: true,
	sidebarWidth: 320,
	sidebarGroupByProject: false,
	sidebarCompactChatItems: false,
	codeEditorTheme: 'auto',
	codeEditorWordWrap: false,
	codeEditorLineNumbers: true,
	codeEditorFontSize: '12',
	gitDiffFontSize: '12',
	markdownViewerFontSize: '12',
	language: 'en',
};

function parseBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function parseString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function parseTheme(value: unknown): ThemeMode {
	if (typeof value === 'string' && (value === 'dark' || value === 'light' || value === 'system')) {
		return value;
	}
	return DEFAULTS.theme;
}

export function isChatMaxWidth(value: unknown): value is ChatMaxWidth {
	return typeof value === 'string' && CHAT_MAX_WIDTH_VALUES.includes(value as ChatMaxWidth);
}

function parseChatMaxWidth(value: unknown): ChatMaxWidth {
	return isChatMaxWidth(value) ? value : DEFAULTS.chatMaxWidth;
}

function parseSidebarWidth(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	return DEFAULTS.sidebarWidth;
}

function parseFromRaw(parsed: Record<string, unknown>): LocalSettingsSnapshot {
	return {
		theme: parseTheme(parsed.theme),
		colorblindMode: parseBoolean(parsed.colorblindMode, DEFAULTS.colorblindMode),
		autoExpandTools: parseBoolean(parsed.autoExpandTools, DEFAULTS.autoExpandTools),
		showThinking: parseBoolean(parsed.showThinking, DEFAULTS.showThinking),
		showQuickCommitTray: parseBoolean(
			parsed.showQuickCommitTray,
			DEFAULTS.showQuickCommitTray,
		),
		autoScrollToBottom: parseBoolean(parsed.autoScrollToBottom, DEFAULTS.autoScrollToBottom),
		sendByShiftEnter: parseBoolean(parsed.sendByShiftEnter, DEFAULTS.sendByShiftEnter),
		chatMaxWidth: parseChatMaxWidth(parsed.chatMaxWidth),
		alwaysFullscreenOnGitPanel: parseBoolean(
			parsed.alwaysFullscreenOnGitPanel,
			DEFAULTS.alwaysFullscreenOnGitPanel,
		),
		sidebarVisible: parseBoolean(parsed.sidebarVisible, DEFAULTS.sidebarVisible),
		sidebarWidth: parseSidebarWidth(parsed.sidebarWidth),
		sidebarGroupByProject: parseBoolean(
			parsed.sidebarGroupByProject,
			DEFAULTS.sidebarGroupByProject,
		),
		sidebarCompactChatItems: parseBoolean(
			parsed.sidebarCompactChatItems,
			DEFAULTS.sidebarCompactChatItems,
		),
		codeEditorTheme: parseString(parsed.codeEditorTheme, DEFAULTS.codeEditorTheme),
		codeEditorWordWrap: parseBoolean(parsed.codeEditorWordWrap, DEFAULTS.codeEditorWordWrap),
		codeEditorLineNumbers: parseBoolean(
			parsed.codeEditorLineNumbers,
			DEFAULTS.codeEditorLineNumbers,
		),
		codeEditorFontSize: parseString(parsed.codeEditorFontSize, DEFAULTS.codeEditorFontSize),
		gitDiffFontSize: parseString(parsed.gitDiffFontSize, DEFAULTS.gitDiffFontSize),
		markdownViewerFontSize: parseString(
			parsed.markdownViewerFontSize,
			DEFAULTS.markdownViewerFontSize,
		),
		language: parseString(parsed.language, DEFAULTS.language),
	};
}

// Reads the persisted local settings snapshot.
function readPersistedLocalSettings(): LocalSettingsSnapshot {
	try {
		const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.localSettings);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				return parseFromRaw(parsed);
			}
		}
	} catch {
		// Corrupt storage
	}
	return { ...DEFAULTS };
}

function persistLocalSettings(snapshot: LocalSettingsSnapshot): void {
	setLocalStorageItem(LOCAL_STORAGE_KEYS.localSettings, JSON.stringify(snapshot));
}

export class LocalSettingsStore {
	theme = $state<ThemeMode>(DEFAULTS.theme);
	colorblindMode = $state(DEFAULTS.colorblindMode);
	autoExpandTools = $state(DEFAULTS.autoExpandTools);
	showThinking = $state(DEFAULTS.showThinking);
	showQuickCommitTray = $state(DEFAULTS.showQuickCommitTray);
	autoScrollToBottom = $state(DEFAULTS.autoScrollToBottom);
	sendByShiftEnter = $state(DEFAULTS.sendByShiftEnter);
	chatMaxWidth = $state<ChatMaxWidth>(DEFAULTS.chatMaxWidth);
	alwaysFullscreenOnGitPanel = $state(DEFAULTS.alwaysFullscreenOnGitPanel);
	sidebarVisible = $state(DEFAULTS.sidebarVisible);
	sidebarWidth = $state(DEFAULTS.sidebarWidth);
	sidebarGroupByProject = $state(DEFAULTS.sidebarGroupByProject);
	sidebarCompactChatItems = $state(DEFAULTS.sidebarCompactChatItems);
	codeEditorTheme = $state(DEFAULTS.codeEditorTheme);
	codeEditorWordWrap = $state(DEFAULTS.codeEditorWordWrap);
	codeEditorLineNumbers = $state(DEFAULTS.codeEditorLineNumbers);
	codeEditorFontSize = $state(DEFAULTS.codeEditorFontSize);
	gitDiffFontSize = $state(DEFAULTS.gitDiffFontSize);
	markdownViewerFontSize = $state(DEFAULTS.markdownViewerFontSize);
	language = $state(DEFAULTS.language);

	#storageListener = (event: StorageEvent) => {
		if (event.key !== LOCAL_STORAGE_KEYS.localSettings) return;
		this.#apply(readPersistedLocalSettings());
	};

	constructor() {
		const initial = readPersistedLocalSettings();
		this.#apply(initial);
		if (typeof window !== 'undefined') {
			window.addEventListener('storage', this.#storageListener);
		}
	}

	destroy(): void {
		if (typeof window !== 'undefined') {
			window.removeEventListener('storage', this.#storageListener);
		}
	}

	set<K extends keyof LocalSettingsSnapshot>(key: K, value: LocalSettingsSnapshot[K]): void {
		(this as unknown as Record<K, LocalSettingsSnapshot[K]>)[key] = value;
		persistLocalSettings(this.snapshot());
	}

	toggle(key: BooleanLocalSettingKey): void {
		this.set(key, !this[key]);
	}

	snapshot(): LocalSettingsSnapshot {
		return {
			theme: this.theme,
			colorblindMode: this.colorblindMode,
			autoExpandTools: this.autoExpandTools,
			showThinking: this.showThinking,
			showQuickCommitTray: this.showQuickCommitTray,
			autoScrollToBottom: this.autoScrollToBottom,
			sendByShiftEnter: this.sendByShiftEnter,
			chatMaxWidth: this.chatMaxWidth,
			alwaysFullscreenOnGitPanel: this.alwaysFullscreenOnGitPanel,
			sidebarVisible: this.sidebarVisible,
			sidebarWidth: this.sidebarWidth,
			sidebarGroupByProject: this.sidebarGroupByProject,
			sidebarCompactChatItems: this.sidebarCompactChatItems,
			codeEditorTheme: this.codeEditorTheme,
			codeEditorWordWrap: this.codeEditorWordWrap,
			codeEditorLineNumbers: this.codeEditorLineNumbers,
			codeEditorFontSize: this.codeEditorFontSize,
			gitDiffFontSize: this.gitDiffFontSize,
			markdownViewerFontSize: this.markdownViewerFontSize,
			language: this.language,
		};
	}

	#apply(snap: LocalSettingsSnapshot): void {
		this.theme = snap.theme;
		this.colorblindMode = snap.colorblindMode;
		this.autoExpandTools = snap.autoExpandTools;
		this.showThinking = snap.showThinking;
		this.showQuickCommitTray = snap.showQuickCommitTray;
		this.autoScrollToBottom = snap.autoScrollToBottom;
		this.sendByShiftEnter = snap.sendByShiftEnter;
		this.chatMaxWidth = snap.chatMaxWidth;
		this.alwaysFullscreenOnGitPanel = snap.alwaysFullscreenOnGitPanel;
		this.sidebarVisible = snap.sidebarVisible;
		this.sidebarWidth = snap.sidebarWidth;
		this.sidebarGroupByProject = snap.sidebarGroupByProject;
		this.sidebarCompactChatItems = snap.sidebarCompactChatItems;
		this.codeEditorTheme = snap.codeEditorTheme;
		this.codeEditorWordWrap = snap.codeEditorWordWrap;
		this.codeEditorLineNumbers = snap.codeEditorLineNumbers;
		this.codeEditorFontSize = snap.codeEditorFontSize;
		this.gitDiffFontSize = snap.gitDiffFontSize;
		this.markdownViewerFontSize = snap.markdownViewerFontSize;
		this.language = snap.language;
	}
}

export function createLocalSettingsStore(): LocalSettingsStore {
	return new LocalSettingsStore();
}
