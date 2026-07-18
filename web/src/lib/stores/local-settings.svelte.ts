// Reactive local settings store using Svelte 5 runes. Persists
// browser-only preferences to persisted storage.

import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import type { DesktopPlacement } from '$lib/workspace/surface-types.js';
import { parseFontSizeOption, type FontSizeOption } from '$lib/utils/font-size.js';

export type ThemeMode = 'dark' | 'light' | 'system';
export const CHAT_MAX_WIDTH_VALUES = ['none', 'large', 'medium', 'small'] as const;
export type ChatMaxWidth = (typeof CHAT_MAX_WIDTH_VALUES)[number];
export const SIDEBAR_SORT_MODE_VALUES = ['manual', 'recent'] as const;
export type SidebarSortMode = (typeof SIDEBAR_SORT_MODE_VALUES)[number];
export type FileOpenPlacementPreference = DesktopPlacement | 'source';
export const FILE_OPEN_PLACEMENT_VALUES = [
	'source',
	'dialog',
	'main',
	'sidebar',
] as const satisfies readonly FileOpenPlacementPreference[];
export const HIDEABLE_TOOL_GROUPS = [
	{
		id: 'commands',
		toolTypes: ['bash-tool-use', 'exec-tool-use', 'wait-tool-use', 'write-stdin-tool-use'],
	},
	{
		id: 'file-reads',
		toolTypes: ['read-tool-use', 'list-tool-use', 'grep-tool-use', 'glob-tool-use'],
	},
	{
		id: 'file-changes',
		toolTypes: ['edit-tool-use', 'write-tool-use', 'apply-patch-tool-use'],
	},
	{
		id: 'web',
		toolTypes: ['web-search-tool-use', 'web-fetch-tool-use'],
	},
	{
		id: 'tasks',
		toolTypes: [
			'todo-write-tool-use',
			'todo-read-tool-use',
			'task-tool-use',
			'codex-subagent-tool-use',
			'update-plan-tool-use',
			'enter-plan-mode-tool-use',
			'cursor-create-plan-tool-use',
			'amp-task-list-tool-use',
			'amp-handoff-tool-use',
		],
	},
	{
		id: 'provider',
		toolTypes: [
			'amp-finder-tool-use',
			'amp-oracle-tool-use',
			'amp-librarian-tool-use',
			'amp-skill-tool-use',
			'amp-mermaid-tool-use',
			'amp-look-at-tool-use',
			'amp-find-thread-tool-use',
			'amp-read-thread-tool-use',
			'external-tool-use',
			'mcp-tool-use',
		],
	},
] as const;
export type HideableToolType = (typeof HIDEABLE_TOOL_GROUPS)[number]['toolTypes'][number];
export const HIDEABLE_TOOL_TYPE_VALUES: readonly HideableToolType[] = HIDEABLE_TOOL_GROUPS.flatMap(
	(group) => group.toolTypes,
);

export interface LocalSettingsSnapshot {
	theme: ThemeMode;
	colorblindMode: boolean;
	overlayBackdropEffects: boolean;
	autoExpandTools: boolean;
	showThinking: boolean;
	showQuickCommitTray: boolean;
	autoScrollToBottom: boolean;
	sendByShiftEnter: boolean;
	chatMaxWidth: ChatMaxWidth;
	hideChatListWhenGitInMain: boolean;
	sidebarVisible: boolean;
	sidebarWidth: number;
	sidebarGroupByProject: boolean;
	sidebarGroupNestedProjectPaths: boolean;
	sidebarCompactChatItems: boolean;
	sidebarSortMode: SidebarSortMode;
	codeEditorWordWrap: boolean;
	codeEditorLineNumbers: boolean;
	codeEditorFontSize: string;
	gitDiffFontSize: string;
	markdownViewerFontSize: string;
	terminalFontSize: FontSizeOption;
	textEditorOpenPlacement: FileOpenPlacementPreference;
	imageViewerOpenPlacement: FileOpenPlacementPreference;
	markdownViewerOpenPlacement: FileOpenPlacementPreference;
	language: string;
	hiddenToolTypes: HideableToolType[];
}

type BooleanLocalSettingKey =
	| 'colorblindMode'
	| 'overlayBackdropEffects'
	| 'autoExpandTools'
	| 'showThinking'
	| 'showQuickCommitTray'
	| 'autoScrollToBottom'
	| 'sendByShiftEnter'
	| 'hideChatListWhenGitInMain'
	| 'sidebarVisible'
	| 'sidebarGroupByProject'
	| 'sidebarGroupNestedProjectPaths'
	| 'sidebarCompactChatItems'
	| 'codeEditorWordWrap'
	| 'codeEditorLineNumbers';

const DEFAULTS: LocalSettingsSnapshot = {
	theme: 'system',
	colorblindMode: false,
	overlayBackdropEffects: true,
	autoExpandTools: false,
	showThinking: true,
	showQuickCommitTray: true,
	autoScrollToBottom: true,
	sendByShiftEnter: false,
	chatMaxWidth: 'none',
	hideChatListWhenGitInMain: false,
	sidebarVisible: true,
	sidebarWidth: 320,
	sidebarGroupByProject: true,
	sidebarGroupNestedProjectPaths: false,
	sidebarCompactChatItems: false,
	sidebarSortMode: 'manual',
	codeEditorWordWrap: false,
	codeEditorLineNumbers: true,
	codeEditorFontSize: '12',
	gitDiffFontSize: '12',
	markdownViewerFontSize: '12',
	terminalFontSize: '13',
	textEditorOpenPlacement: 'source',
	imageViewerOpenPlacement: 'source',
	markdownViewerOpenPlacement: 'source',
	language: 'en',
	hiddenToolTypes: [],
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

function parseSidebarSortMode(value: unknown): SidebarSortMode {
	return typeof value === 'string' && SIDEBAR_SORT_MODE_VALUES.includes(value as SidebarSortMode)
		? (value as SidebarSortMode)
		: DEFAULTS.sidebarSortMode;
}

export function isFileOpenPlacement(value: unknown): value is FileOpenPlacementPreference {
	return (
		typeof value === 'string' &&
		FILE_OPEN_PLACEMENT_VALUES.includes(value as FileOpenPlacementPreference)
	);
}

function parseFileOpenPlacement(
	value: unknown,
	fallback: FileOpenPlacementPreference,
): FileOpenPlacementPreference {
	return isFileOpenPlacement(value) ? value : fallback;
}

function normalizeHiddenToolTypes(value: unknown): HideableToolType[] {
	if (!Array.isArray(value)) return DEFAULTS.hiddenToolTypes;
	const selected = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
	return HIDEABLE_TOOL_GROUPS.flatMap((group) =>
		group.toolTypes.some((toolType) => selected.has(toolType)) ? [...group.toolTypes] : [],
	);
}

function parseFromRaw(parsed: Record<string, unknown>): LocalSettingsSnapshot {
	return {
		theme: parseTheme(parsed.theme),
		colorblindMode: parseBoolean(parsed.colorblindMode, DEFAULTS.colorblindMode),
		overlayBackdropEffects: parseBoolean(
			parsed.overlayBackdropEffects,
			DEFAULTS.overlayBackdropEffects,
		),
		autoExpandTools: parseBoolean(parsed.autoExpandTools, DEFAULTS.autoExpandTools),
		showThinking: parseBoolean(parsed.showThinking, DEFAULTS.showThinking),
		showQuickCommitTray: parseBoolean(parsed.showQuickCommitTray, DEFAULTS.showQuickCommitTray),
		autoScrollToBottom: parseBoolean(parsed.autoScrollToBottom, DEFAULTS.autoScrollToBottom),
		sendByShiftEnter: parseBoolean(parsed.sendByShiftEnter, DEFAULTS.sendByShiftEnter),
		chatMaxWidth: parseChatMaxWidth(parsed.chatMaxWidth),
		hideChatListWhenGitInMain: parseBoolean(
			parsed.hideChatListWhenGitInMain,
			DEFAULTS.hideChatListWhenGitInMain,
		),
		sidebarVisible: parseBoolean(parsed.sidebarVisible, DEFAULTS.sidebarVisible),
		sidebarWidth: parseSidebarWidth(parsed.sidebarWidth),
		sidebarGroupByProject: parseBoolean(
			parsed.sidebarGroupByProject,
			DEFAULTS.sidebarGroupByProject,
		),
		sidebarGroupNestedProjectPaths: parseBoolean(
			parsed.sidebarGroupNestedProjectPaths,
			DEFAULTS.sidebarGroupNestedProjectPaths,
		),
		sidebarCompactChatItems: parseBoolean(
			parsed.sidebarCompactChatItems,
			DEFAULTS.sidebarCompactChatItems,
		),
		sidebarSortMode: parseSidebarSortMode(parsed.sidebarSortMode),
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
		terminalFontSize: parseFontSizeOption(parsed.terminalFontSize, DEFAULTS.terminalFontSize),
		textEditorOpenPlacement: parseFileOpenPlacement(
			parsed.textEditorOpenPlacement,
			DEFAULTS.textEditorOpenPlacement,
		),
		imageViewerOpenPlacement: parseFileOpenPlacement(
			parsed.imageViewerOpenPlacement,
			DEFAULTS.imageViewerOpenPlacement,
		),
		markdownViewerOpenPlacement: parseFileOpenPlacement(
			parsed.markdownViewerOpenPlacement,
			DEFAULTS.markdownViewerOpenPlacement,
		),
		language: parseString(parsed.language, DEFAULTS.language),
		hiddenToolTypes: normalizeHiddenToolTypes(parsed.hiddenToolTypes),
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
	overlayBackdropEffects = $state(DEFAULTS.overlayBackdropEffects);
	autoExpandTools = $state(DEFAULTS.autoExpandTools);
	showThinking = $state(DEFAULTS.showThinking);
	showQuickCommitTray = $state(DEFAULTS.showQuickCommitTray);
	autoScrollToBottom = $state(DEFAULTS.autoScrollToBottom);
	sendByShiftEnter = $state(DEFAULTS.sendByShiftEnter);
	chatMaxWidth = $state<ChatMaxWidth>(DEFAULTS.chatMaxWidth);
	hideChatListWhenGitInMain = $state(DEFAULTS.hideChatListWhenGitInMain);
	sidebarVisible = $state(DEFAULTS.sidebarVisible);
	sidebarWidth = $state(DEFAULTS.sidebarWidth);
	sidebarGroupByProject = $state(DEFAULTS.sidebarGroupByProject);
	sidebarGroupNestedProjectPaths = $state(DEFAULTS.sidebarGroupNestedProjectPaths);
	sidebarCompactChatItems = $state(DEFAULTS.sidebarCompactChatItems);
	sidebarSortMode = $state<SidebarSortMode>(DEFAULTS.sidebarSortMode);
	codeEditorWordWrap = $state(DEFAULTS.codeEditorWordWrap);
	codeEditorLineNumbers = $state(DEFAULTS.codeEditorLineNumbers);
	codeEditorFontSize = $state(DEFAULTS.codeEditorFontSize);
	gitDiffFontSize = $state(DEFAULTS.gitDiffFontSize);
	markdownViewerFontSize = $state(DEFAULTS.markdownViewerFontSize);
	terminalFontSize = $state(DEFAULTS.terminalFontSize);
	textEditorOpenPlacement = $state<FileOpenPlacementPreference>(DEFAULTS.textEditorOpenPlacement);
	imageViewerOpenPlacement = $state<FileOpenPlacementPreference>(DEFAULTS.imageViewerOpenPlacement);
	markdownViewerOpenPlacement = $state<FileOpenPlacementPreference>(
		DEFAULTS.markdownViewerOpenPlacement,
	);
	language = $state(DEFAULTS.language);
	hiddenToolTypes = $state<HideableToolType[]>(DEFAULTS.hiddenToolTypes);

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
		const normalizedValue = key === 'hiddenToolTypes' ? normalizeHiddenToolTypes(value) : value;
		(this as unknown as Record<K, LocalSettingsSnapshot[K]>)[key] =
			normalizedValue as LocalSettingsSnapshot[K];
		persistLocalSettings(this.snapshot());
	}

	toggle(key: BooleanLocalSettingKey): void {
		this.set(key, !this[key]);
	}

	areToolTypesHidden(toolTypes: readonly HideableToolType[]): boolean {
		return toolTypes.every((toolType) => this.hiddenToolTypes.includes(toolType));
	}

	setToolTypesHidden(toolTypes: readonly HideableToolType[], hidden: boolean): void {
		const selected = new Set(normalizeHiddenToolTypes(toolTypes));
		const hiddenToolTypes = hidden
			? Array.from(new Set([...this.hiddenToolTypes, ...selected]))
			: this.hiddenToolTypes.filter((toolType) => !selected.has(toolType));
		this.set('hiddenToolTypes', hiddenToolTypes);
	}

	snapshot(): LocalSettingsSnapshot {
		return {
			theme: this.theme,
			colorblindMode: this.colorblindMode,
			overlayBackdropEffects: this.overlayBackdropEffects,
			autoExpandTools: this.autoExpandTools,
			showThinking: this.showThinking,
			showQuickCommitTray: this.showQuickCommitTray,
			autoScrollToBottom: this.autoScrollToBottom,
			sendByShiftEnter: this.sendByShiftEnter,
			chatMaxWidth: this.chatMaxWidth,
			hideChatListWhenGitInMain: this.hideChatListWhenGitInMain,
			sidebarVisible: this.sidebarVisible,
			sidebarWidth: this.sidebarWidth,
			sidebarGroupByProject: this.sidebarGroupByProject,
			sidebarGroupNestedProjectPaths: this.sidebarGroupNestedProjectPaths,
			sidebarCompactChatItems: this.sidebarCompactChatItems,
			sidebarSortMode: this.sidebarSortMode,
			codeEditorWordWrap: this.codeEditorWordWrap,
			codeEditorLineNumbers: this.codeEditorLineNumbers,
			codeEditorFontSize: this.codeEditorFontSize,
			gitDiffFontSize: this.gitDiffFontSize,
			markdownViewerFontSize: this.markdownViewerFontSize,
			terminalFontSize: this.terminalFontSize,
			textEditorOpenPlacement: this.textEditorOpenPlacement,
			imageViewerOpenPlacement: this.imageViewerOpenPlacement,
			markdownViewerOpenPlacement: this.markdownViewerOpenPlacement,
			language: this.language,
			hiddenToolTypes: this.hiddenToolTypes,
		};
	}

	#apply(snap: LocalSettingsSnapshot): void {
		this.theme = snap.theme;
		this.colorblindMode = snap.colorblindMode;
		this.overlayBackdropEffects = snap.overlayBackdropEffects;
		this.autoExpandTools = snap.autoExpandTools;
		this.showThinking = snap.showThinking;
		this.showQuickCommitTray = snap.showQuickCommitTray;
		this.autoScrollToBottom = snap.autoScrollToBottom;
		this.sendByShiftEnter = snap.sendByShiftEnter;
		this.chatMaxWidth = snap.chatMaxWidth;
		this.hideChatListWhenGitInMain = snap.hideChatListWhenGitInMain;
		this.sidebarVisible = snap.sidebarVisible;
		this.sidebarWidth = snap.sidebarWidth;
		this.sidebarGroupByProject = snap.sidebarGroupByProject;
		this.sidebarGroupNestedProjectPaths = snap.sidebarGroupNestedProjectPaths;
		this.sidebarCompactChatItems = snap.sidebarCompactChatItems;
		this.sidebarSortMode = snap.sidebarSortMode;
		this.codeEditorWordWrap = snap.codeEditorWordWrap;
		this.codeEditorLineNumbers = snap.codeEditorLineNumbers;
		this.codeEditorFontSize = snap.codeEditorFontSize;
		this.gitDiffFontSize = snap.gitDiffFontSize;
		this.markdownViewerFontSize = snap.markdownViewerFontSize;
		this.terminalFontSize = snap.terminalFontSize;
		this.textEditorOpenPlacement = snap.textEditorOpenPlacement;
		this.imageViewerOpenPlacement = snap.imageViewerOpenPlacement;
		this.markdownViewerOpenPlacement = snap.markdownViewerOpenPlacement;
		this.language = snap.language;
		this.hiddenToolTypes = snap.hiddenToolTypes;
	}
}

export function createLocalSettingsStore(): LocalSettingsStore {
	return new LocalSettingsStore();
}
