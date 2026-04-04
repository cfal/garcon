// Reactive local settings store using Svelte 5 runes. Persists
// browser-only preferences to localStorage.

import type { SidebarSearchBarPosition } from '$lib/types/session.js';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface LocalSettingsSnapshot {
	theme: ThemeMode;
	colorblindMode: boolean;
	autoExpandTools: boolean;
	showThinking: boolean;
	autoScrollToBottom: boolean;
	sendByShiftEnter: boolean;
	showChatHeader: boolean;
	alwaysFullscreenOnGitPanel: boolean;
	sidebarVisible: boolean;
	sidebarWidth: number;
	searchBarPosition: SidebarSearchBarPosition;
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
	| 'autoScrollToBottom'
	| 'sendByShiftEnter'
	| 'showChatHeader'
	| 'alwaysFullscreenOnGitPanel'
	| 'sidebarVisible'
	| 'codeEditorWordWrap'
	| 'codeEditorLineNumbers';

const STORAGE_KEY = 'pref_local_settings';
const DEFAULTS: LocalSettingsSnapshot = {
	theme: 'system',
	colorblindMode: false,
	autoExpandTools: false,
	showThinking: true,
	autoScrollToBottom: true,
	sendByShiftEnter: false,
	showChatHeader: false,
	alwaysFullscreenOnGitPanel: true,
	sidebarVisible: true,
	sidebarWidth: 320,
	searchBarPosition: 'top',
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

function parseSidebarWidth(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	return DEFAULTS.sidebarWidth;
}

function parseSearchBarPosition(value: unknown): SidebarSearchBarPosition {
	return value === 'bottom' ? 'bottom' : 'top';
}

function parseFromRaw(parsed: Record<string, unknown>): LocalSettingsSnapshot {
	return {
		theme: parseTheme(parsed.theme),
		colorblindMode: parseBoolean(parsed.colorblindMode, DEFAULTS.colorblindMode),
		autoExpandTools: parseBoolean(parsed.autoExpandTools, DEFAULTS.autoExpandTools),
		showThinking: parseBoolean(parsed.showThinking, DEFAULTS.showThinking),
		autoScrollToBottom: parseBoolean(parsed.autoScrollToBottom, DEFAULTS.autoScrollToBottom),
		sendByShiftEnter: parseBoolean(parsed.sendByShiftEnter, DEFAULTS.sendByShiftEnter),
		showChatHeader: parseBoolean(parsed.showChatHeader, DEFAULTS.showChatHeader),
		alwaysFullscreenOnGitPanel: parseBoolean(parsed.alwaysFullscreenOnGitPanel, DEFAULTS.alwaysFullscreenOnGitPanel),
		sidebarVisible: parseBoolean(parsed.sidebarVisible, DEFAULTS.sidebarVisible),
		sidebarWidth: parseSidebarWidth(parsed.sidebarWidth),
		searchBarPosition: parseSearchBarPosition(parsed.searchBarPosition),
		codeEditorTheme: parseString(parsed.codeEditorTheme, DEFAULTS.codeEditorTheme),
		codeEditorWordWrap: parseBoolean(parsed.codeEditorWordWrap, DEFAULTS.codeEditorWordWrap),
		codeEditorLineNumbers: parseBoolean(parsed.codeEditorLineNumbers, DEFAULTS.codeEditorLineNumbers),
		codeEditorFontSize: parseString(parsed.codeEditorFontSize, DEFAULTS.codeEditorFontSize),
		gitDiffFontSize: parseString(parsed.gitDiffFontSize, DEFAULTS.gitDiffFontSize),
		markdownViewerFontSize: parseString(parsed.markdownViewerFontSize, DEFAULTS.markdownViewerFontSize),
		language: parseString(parsed.language, DEFAULTS.language),
	};
}

// Reads the persisted snapshot from localStorage.
function readPersistedLocalSettings(): LocalSettingsSnapshot {
	if (typeof window === 'undefined') return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
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
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
	} catch {
		// Storage full or unavailable
	}
}

export class LocalSettingsStore {
	theme = $state<ThemeMode>(DEFAULTS.theme);
	colorblindMode = $state(DEFAULTS.colorblindMode);
	autoExpandTools = $state(DEFAULTS.autoExpandTools);
	showThinking = $state(DEFAULTS.showThinking);
	autoScrollToBottom = $state(DEFAULTS.autoScrollToBottom);
	sendByShiftEnter = $state(DEFAULTS.sendByShiftEnter);
	showChatHeader = $state(DEFAULTS.showChatHeader);
	alwaysFullscreenOnGitPanel = $state(DEFAULTS.alwaysFullscreenOnGitPanel);
	sidebarVisible = $state(DEFAULTS.sidebarVisible);
	sidebarWidth = $state(DEFAULTS.sidebarWidth);
	searchBarPosition = $state<SidebarSearchBarPosition>(DEFAULTS.searchBarPosition);
	codeEditorTheme = $state(DEFAULTS.codeEditorTheme);
	codeEditorWordWrap = $state(DEFAULTS.codeEditorWordWrap);
	codeEditorLineNumbers = $state(DEFAULTS.codeEditorLineNumbers);
	codeEditorFontSize = $state(DEFAULTS.codeEditorFontSize);
	gitDiffFontSize = $state(DEFAULTS.gitDiffFontSize);
	markdownViewerFontSize = $state(DEFAULTS.markdownViewerFontSize);
	language = $state(DEFAULTS.language);

	#storageListener = (event: StorageEvent) => {
		if (event.key !== STORAGE_KEY) return;
		this.#apply(readPersistedLocalSettings());
	};

	constructor() {
		const initial = readPersistedLocalSettings();
		this.#apply(initial);
		// Normalize to new key on first load.
		persistLocalSettings(initial);
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
			autoScrollToBottom: this.autoScrollToBottom,
			sendByShiftEnter: this.sendByShiftEnter,
			showChatHeader: this.showChatHeader,
			alwaysFullscreenOnGitPanel: this.alwaysFullscreenOnGitPanel,
			sidebarVisible: this.sidebarVisible,
			sidebarWidth: this.sidebarWidth,
			searchBarPosition: this.searchBarPosition,
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
		this.autoScrollToBottom = snap.autoScrollToBottom;
		this.sendByShiftEnter = snap.sendByShiftEnter;
		this.showChatHeader = snap.showChatHeader;
		this.alwaysFullscreenOnGitPanel = snap.alwaysFullscreenOnGitPanel;
		this.sidebarVisible = snap.sidebarVisible;
		this.sidebarWidth = snap.sidebarWidth;
		this.searchBarPosition = snap.searchBarPosition;
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
