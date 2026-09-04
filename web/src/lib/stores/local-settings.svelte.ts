// Reactive local settings store using Svelte 5 runes. Persists
// browser-only preferences to persisted storage.

import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
import { parseFontSizeOption, type FontSizeOption } from '$lib/utils/font-size.js';
import {
	DEFAULT_CHAT_LIST_DOCK,
	normalizeChatListDock,
	type ChatListDock,
} from '$lib/layout/desktop-layout.js';
import {
	sanitizeGlobalShortcutOverrides,
	type GlobalShortcutOverrides,
} from '$lib/workspace/global-shortcuts.js';
import {
	DEFAULT_SNIPPET_TRIGGER,
	normalizeSnippetTrigger,
} from '$lib/chat/composer/snippet-trigger.js';
import {
	normalizeHiddenBashCommandPatterns,
	type HiddenBashCommandPattern,
} from '$lib/chat/transcript/hidden-bash-commands.js';

export type ThemeMode = 'dark' | 'light' | 'system';
export const COMPLETION_SOUND_MODE_VALUES = ['off', 'default', 'custom'] as const;
export type CompletionSoundMode = (typeof COMPLETION_SOUND_MODE_VALUES)[number];
export const COMPLETION_SOUND_VISIBILITY_VALUES = ['always', 'unfocused'] as const;
export type CompletionSoundVisibility = (typeof COMPLETION_SOUND_VISIBILITY_VALUES)[number];
export const CHAT_MAX_WIDTH_VALUES = ['none', 'large', 'medium', 'small'] as const;
export type ChatMaxWidth = (typeof CHAT_MAX_WIDTH_VALUES)[number];
export const SIDEBAR_SORT_MODE_VALUES = ['manual', 'recent'] as const;
export type SidebarSortMode = (typeof SIDEBAR_SORT_MODE_VALUES)[number];

export const SIDEBAR_CHAT_GROUPING_VALUES = [
	'none',
	'project',
	'project-and-activity',
	'activity',
] as const;
export type SidebarChatGrouping = (typeof SIDEBAR_CHAT_GROUPING_VALUES)[number];

export const SIDEBAR_INACTIVITY_DURATION_VALUES = [
	'2-days',
	'3-days',
	'4-days',
	'5-days',
	'1-week',
	'2-weeks',
	'1-month',
	'2-months',
	'3-months',
] as const;
export type SidebarInactivityDuration = (typeof SIDEBAR_INACTIVITY_DURATION_VALUES)[number];

export const SIDEBAR_CHAT_ITEM_LAYOUT_VALUES = ['default', 'compact', 'single-line'] as const;
export type SidebarChatItemLayout = (typeof SIDEBAR_CHAT_ITEM_LAYOUT_VALUES)[number];
export type FileOpenPlacementPreference = 'same-window' | 'new-window' | 'dialog';
export const FILE_OPEN_PLACEMENT_VALUES = [
	'same-window',
	'new-window',
	'dialog',
] as const satisfies readonly FileOpenPlacementPreference[];
export const HIDEABLE_TOOL_GROUPS = [
	{
		id: 'bash',
		toolTypes: ['bash-tool-use', 'write-stdin-tool-use'],
	},
	{
		id: 'exec',
		toolTypes: ['exec-tool-use', 'wait-tool-use'],
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
	alwaysExpandCliMessages: boolean;
	showThinking: boolean;
	allowDirectChats: boolean;
	reduceMotion: boolean;
	showQuickCommitTray: boolean;
	autoScrollToBottom: boolean;
	sendByShiftEnter: boolean;
	steerWithCtrlEnter: boolean;
	snippetTrigger: string;
	chatMaxWidth: ChatMaxWidth;
	chatListAutohide: boolean;
	chatListDock: ChatListDock;
	sidebarVisible: boolean;
	sidebarWidth: number;
	sidebarGrouping: SidebarChatGrouping;
	sidebarInactivityDuration: SidebarInactivityDuration;
	sidebarGroupNestedProjectPaths: boolean;
	sidebarChatItemLayout: SidebarChatItemLayout;
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
	hiddenBashCommandPatterns: HiddenBashCommandPattern[];
	globalShortcuts: GlobalShortcutOverrides;
	completionSoundMode: CompletionSoundMode;
	completionSoundVolume: number;
	completionSoundVisibility: CompletionSoundVisibility;
	customCompletionSoundName: string | null;
}

type BooleanLocalSettingKey =
	| 'colorblindMode'
	| 'overlayBackdropEffects'
	| 'autoExpandTools'
	| 'alwaysExpandCliMessages'
	| 'showThinking'
	| 'allowDirectChats'
	| 'reduceMotion'
	| 'showQuickCommitTray'
	| 'autoScrollToBottom'
	| 'sendByShiftEnter'
	| 'steerWithCtrlEnter'
	| 'chatListAutohide'
	| 'sidebarVisible'
	| 'sidebarGroupNestedProjectPaths'
	| 'codeEditorWordWrap'
	| 'codeEditorLineNumbers';

const DEFAULTS: LocalSettingsSnapshot = {
	theme: 'system',
	colorblindMode: false,
	overlayBackdropEffects: true,
	autoExpandTools: false,
	alwaysExpandCliMessages: false,
	showThinking: true,
	allowDirectChats: false,
	reduceMotion: false,
	showQuickCommitTray: true,
	autoScrollToBottom: true,
	sendByShiftEnter: false,
	steerWithCtrlEnter: true,
	snippetTrigger: DEFAULT_SNIPPET_TRIGGER,
	chatMaxWidth: 'none',
	chatListAutohide: false,
	chatListDock: DEFAULT_CHAT_LIST_DOCK,
	sidebarVisible: true,
	sidebarWidth: 320,
	sidebarGrouping: 'project',
	sidebarInactivityDuration: '3-days',
	sidebarGroupNestedProjectPaths: false,
	sidebarChatItemLayout: 'default',
	sidebarSortMode: 'manual',
	codeEditorWordWrap: false,
	codeEditorLineNumbers: true,
	codeEditorFontSize: '12',
	gitDiffFontSize: '12',
	markdownViewerFontSize: '12',
	terminalFontSize: '13',
	textEditorOpenPlacement: 'same-window',
	imageViewerOpenPlacement: 'same-window',
	markdownViewerOpenPlacement: 'same-window',
	language: 'en',
	hiddenToolTypes: [],
	hiddenBashCommandPatterns: [],
	globalShortcuts: {},
	completionSoundMode: 'off',
	completionSoundVolume: 0.7,
	completionSoundVisibility: 'unfocused',
	customCompletionSoundName: null,
};

function parseBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function parseString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

function parseCompletionSoundMode(value: unknown): CompletionSoundMode {
	return typeof value === 'string' &&
		COMPLETION_SOUND_MODE_VALUES.includes(value as CompletionSoundMode)
		? (value as CompletionSoundMode)
		: DEFAULTS.completionSoundMode;
}

function parseCompletionSoundVolume(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(1, Math.max(0, value))
		: DEFAULTS.completionSoundVolume;
}

function parseCompletionSoundVisibility(value: unknown): CompletionSoundVisibility {
	return typeof value === 'string' &&
		COMPLETION_SOUND_VISIBILITY_VALUES.includes(value as CompletionSoundVisibility)
		? (value as CompletionSoundVisibility)
		: DEFAULTS.completionSoundVisibility;
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

function parseSidebarChatGrouping(value: unknown): SidebarChatGrouping {
	return typeof value === 'string' &&
		SIDEBAR_CHAT_GROUPING_VALUES.includes(value as SidebarChatGrouping)
		? (value as SidebarChatGrouping)
		: DEFAULTS.sidebarGrouping;
}

export function isSidebarInactivityDuration(value: unknown): value is SidebarInactivityDuration {
	return (
		typeof value === 'string' &&
		SIDEBAR_INACTIVITY_DURATION_VALUES.includes(value as SidebarInactivityDuration)
	);
}

function parseSidebarInactivityDuration(value: unknown): SidebarInactivityDuration {
	return isSidebarInactivityDuration(value) ? value : DEFAULTS.sidebarInactivityDuration;
}

function parseSidebarChatItemLayout(value: unknown): SidebarChatItemLayout {
	return typeof value === 'string' &&
		SIDEBAR_CHAT_ITEM_LAYOUT_VALUES.includes(value as SidebarChatItemLayout)
		? (value as SidebarChatItemLayout)
		: DEFAULTS.sidebarChatItemLayout;
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
	if (isFileOpenPlacement(value)) return value;
	return fallback;
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
		alwaysExpandCliMessages: parseBoolean(
			parsed.alwaysExpandCliMessages,
			DEFAULTS.alwaysExpandCliMessages,
		),
		showThinking: parseBoolean(parsed.showThinking, DEFAULTS.showThinking),
		allowDirectChats: parseBoolean(parsed.allowDirectChats, DEFAULTS.allowDirectChats),
		reduceMotion: parseBoolean(parsed.reduceMotion, DEFAULTS.reduceMotion),
		showQuickCommitTray: parseBoolean(parsed.showQuickCommitTray, DEFAULTS.showQuickCommitTray),
		autoScrollToBottom: parseBoolean(parsed.autoScrollToBottom, DEFAULTS.autoScrollToBottom),
		sendByShiftEnter: parseBoolean(parsed.sendByShiftEnter, DEFAULTS.sendByShiftEnter),
		steerWithCtrlEnter: parseBoolean(parsed.steerWithCtrlEnter, DEFAULTS.steerWithCtrlEnter),
		snippetTrigger: normalizeSnippetTrigger(parsed.snippetTrigger),
		chatMaxWidth: parseChatMaxWidth(parsed.chatMaxWidth),
		chatListAutohide: parseBoolean(parsed.chatListAutohide, DEFAULTS.chatListAutohide),
		chatListDock: normalizeChatListDock(parsed.chatListDock),
		sidebarVisible: parseBoolean(parsed.sidebarVisible, DEFAULTS.sidebarVisible),
		sidebarWidth: parseSidebarWidth(parsed.sidebarWidth),
		sidebarGrouping: parseSidebarChatGrouping(parsed.sidebarGrouping),
		sidebarInactivityDuration: parseSidebarInactivityDuration(
			parsed.sidebarInactivityDuration,
		),
		sidebarGroupNestedProjectPaths: parseBoolean(
			parsed.sidebarGroupNestedProjectPaths,
			DEFAULTS.sidebarGroupNestedProjectPaths,
		),
		sidebarChatItemLayout: parseSidebarChatItemLayout(parsed.sidebarChatItemLayout),
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
		hiddenBashCommandPatterns: normalizeHiddenBashCommandPatterns(
			parsed.hiddenBashCommandPatterns,
		),
		globalShortcuts: sanitizeGlobalShortcutOverrides(parsed.globalShortcuts),
		completionSoundMode: parseCompletionSoundMode(parsed.completionSoundMode),
		completionSoundVolume: parseCompletionSoundVolume(parsed.completionSoundVolume),
		completionSoundVisibility: parseCompletionSoundVisibility(parsed.completionSoundVisibility),
		customCompletionSoundName:
			typeof parsed.customCompletionSoundName === 'string'
				? parsed.customCompletionSoundName
				: null,
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
	alwaysExpandCliMessages = $state(DEFAULTS.alwaysExpandCliMessages);
	showThinking = $state(DEFAULTS.showThinking);
	allowDirectChats = $state(DEFAULTS.allowDirectChats);
	reduceMotion = $state(DEFAULTS.reduceMotion);
	showQuickCommitTray = $state(DEFAULTS.showQuickCommitTray);
	autoScrollToBottom = $state(DEFAULTS.autoScrollToBottom);
	sendByShiftEnter = $state(DEFAULTS.sendByShiftEnter);
	steerWithCtrlEnter = $state(DEFAULTS.steerWithCtrlEnter);
	snippetTrigger = $state(DEFAULTS.snippetTrigger);
	chatMaxWidth = $state<ChatMaxWidth>(DEFAULTS.chatMaxWidth);
	chatListAutohide = $state(DEFAULTS.chatListAutohide);
	chatListDock = $state<ChatListDock>(DEFAULTS.chatListDock);
	sidebarVisible = $state(DEFAULTS.sidebarVisible);
	sidebarWidth = $state(DEFAULTS.sidebarWidth);
	sidebarGrouping = $state<SidebarChatGrouping>(DEFAULTS.sidebarGrouping);
	sidebarInactivityDuration = $state<SidebarInactivityDuration>(
		DEFAULTS.sidebarInactivityDuration,
	);
	sidebarGroupNestedProjectPaths = $state(DEFAULTS.sidebarGroupNestedProjectPaths);
	sidebarChatItemLayout = $state<SidebarChatItemLayout>(DEFAULTS.sidebarChatItemLayout);
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
	hiddenBashCommandPatterns = $state<HiddenBashCommandPattern[]>(
		DEFAULTS.hiddenBashCommandPatterns,
	);
	globalShortcuts = $state<GlobalShortcutOverrides>(DEFAULTS.globalShortcuts);
	completionSoundMode = $state<CompletionSoundMode>(DEFAULTS.completionSoundMode);
	completionSoundVolume = $state(DEFAULTS.completionSoundVolume);
	completionSoundVisibility = $state<CompletionSoundVisibility>(
		DEFAULTS.completionSoundVisibility,
	);
	customCompletionSoundName = $state<string | null>(DEFAULTS.customCompletionSoundName);

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
		const next = { ...this.snapshot(), [key]: value };
		if (key === 'snippetTrigger') next.snippetTrigger = normalizeSnippetTrigger(value);
		if (key === 'hiddenToolTypes') next.hiddenToolTypes = normalizeHiddenToolTypes(value);
		if (key === 'hiddenBashCommandPatterns') {
			next.hiddenBashCommandPatterns = normalizeHiddenBashCommandPatterns(value);
		}
		if (key === 'chatListDock') {
			next.chatListDock = normalizeChatListDock(value);
		}
		if (key === 'globalShortcuts') {
			next.globalShortcuts = sanitizeGlobalShortcutOverrides(value);
		}
		if (key === 'completionSoundVolume') {
			next.completionSoundVolume = parseCompletionSoundVolume(value);
		}
		this.#apply(next);
		persistLocalSettings(next);
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

	addHiddenBashCommandPattern(pattern: HiddenBashCommandPattern): void {
		this.set('hiddenBashCommandPatterns', [...this.hiddenBashCommandPatterns, pattern]);
	}

	removeHiddenBashCommandPattern(pattern: HiddenBashCommandPattern): void {
		this.set(
			'hiddenBashCommandPatterns',
			this.hiddenBashCommandPatterns.filter(
				(entry) => entry.pattern !== pattern.pattern || entry.mode !== pattern.mode,
			),
		);
	}

	snapshot(): LocalSettingsSnapshot {
		return {
			theme: this.theme,
			colorblindMode: this.colorblindMode,
			overlayBackdropEffects: this.overlayBackdropEffects,
			autoExpandTools: this.autoExpandTools,
			alwaysExpandCliMessages: this.alwaysExpandCliMessages,
			showThinking: this.showThinking,
			allowDirectChats: this.allowDirectChats,
			reduceMotion: this.reduceMotion,
			showQuickCommitTray: this.showQuickCommitTray,
			autoScrollToBottom: this.autoScrollToBottom,
			sendByShiftEnter: this.sendByShiftEnter,
			steerWithCtrlEnter: this.steerWithCtrlEnter,
			snippetTrigger: this.snippetTrigger,
			chatMaxWidth: this.chatMaxWidth,
			chatListAutohide: this.chatListAutohide,
			chatListDock: this.chatListDock,
			sidebarVisible: this.sidebarVisible,
			sidebarWidth: this.sidebarWidth,
			sidebarGrouping: this.sidebarGrouping,
			sidebarInactivityDuration: this.sidebarInactivityDuration,
			sidebarGroupNestedProjectPaths: this.sidebarGroupNestedProjectPaths,
			sidebarChatItemLayout: this.sidebarChatItemLayout,
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
			hiddenBashCommandPatterns: this.hiddenBashCommandPatterns.map((pattern) => ({ ...pattern })),
			globalShortcuts: { ...this.globalShortcuts },
			completionSoundMode: this.completionSoundMode,
			completionSoundVolume: this.completionSoundVolume,
			completionSoundVisibility: this.completionSoundVisibility,
			customCompletionSoundName: this.customCompletionSoundName,
		};
	}

	#apply(snap: LocalSettingsSnapshot): void {
		this.theme = snap.theme;
		this.colorblindMode = snap.colorblindMode;
		this.overlayBackdropEffects = snap.overlayBackdropEffects;
		this.autoExpandTools = snap.autoExpandTools;
		this.alwaysExpandCliMessages = snap.alwaysExpandCliMessages;
		this.showThinking = snap.showThinking;
		this.allowDirectChats = snap.allowDirectChats;
		this.reduceMotion = snap.reduceMotion;
		this.showQuickCommitTray = snap.showQuickCommitTray;
		this.autoScrollToBottom = snap.autoScrollToBottom;
		this.sendByShiftEnter = snap.sendByShiftEnter;
		this.steerWithCtrlEnter = snap.steerWithCtrlEnter;
		this.snippetTrigger = snap.snippetTrigger;
		this.chatMaxWidth = snap.chatMaxWidth;
		this.chatListAutohide = snap.chatListAutohide;
		this.chatListDock = snap.chatListDock;
		this.sidebarVisible = snap.sidebarVisible;
		this.sidebarWidth = snap.sidebarWidth;
		this.sidebarGrouping = snap.sidebarGrouping;
		this.sidebarInactivityDuration = snap.sidebarInactivityDuration;
		this.sidebarGroupNestedProjectPaths = snap.sidebarGroupNestedProjectPaths;
		this.sidebarChatItemLayout = snap.sidebarChatItemLayout;
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
		this.hiddenBashCommandPatterns = snap.hiddenBashCommandPatterns.map((pattern) => ({
			...pattern,
		}));
		this.globalShortcuts = { ...snap.globalShortcuts };
		this.completionSoundMode = snap.completionSoundMode;
		this.completionSoundVolume = snap.completionSoundVolume;
		this.completionSoundVisibility = snap.completionSoundVisibility;
		this.customCompletionSoundName = snap.customCompletionSoundName;
	}
}

export function createLocalSettingsStore(): LocalSettingsStore {
	return new LocalSettingsStore();
}
