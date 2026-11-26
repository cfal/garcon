// Reactive local settings store using Svelte 5 runes. Persists
// browser-only preferences to persisted storage.

import { untrack } from 'svelte';
import type { ComposerInputMode } from '$lib/chat/composer/markdown-input.js';
import {
	defaultSidebarDisplayPreferences,
	type SidebarDisplayPreferences,
} from '$lib/sidebar/display/sidebar-display-options';
import {
	defaultSidebarGroupingFields,
	normalizeSidebarGroupingFields,
	type SidebarGroupingSelection,
} from '$lib/sidebar/display/sidebar-preferences';
import {
	COMPOSER_STATUS_BAR_DEFAULTS,
	type ComposerStatusBarPreferences,
} from '$lib/chat/composer/composer-status-bar.js';
import {
	TYPOGRAPHY_SURFACES,
	parseSurfaceFont,
	parseFontSizePreference,
	TYPOGRAPHY_DEFAULTS,
	getTypographySurface,
	type TypographySurface,
	type FontSizePreference,
	type TypographyPreferences,
} from '$lib/theme/typography.js';
import type { FontPreference } from '$lib/theme/fonts.js';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';
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
import { CHAT_SEARCH_SORT_VALUES, type ChatSearchSort } from '$shared/chat-search';
import {
	DEFAULT_THEME_PREFERENCE,
	parseThemePreference,
	type ThemePreference,
} from '$lib/theme/themes.js';
import {
	parseChatItemLayout as parseStoredChatItemLayout,
	type ChatItemLayout,
} from '$lib/layout/chat-item-layout.js';
import {
	CHAT_BOARD_MAX_COUNT,
	isChatBoardColumnId,
	isChatBoardId,
	type ChatBoard,
} from '$shared/chat-boards';

export const COMPLETION_SOUND_MODE_VALUES = ['off', 'default', 'custom'] as const;
export type CompletionSoundMode = (typeof COMPLETION_SOUND_MODE_VALUES)[number];
const COMPLETION_SOUND_VISIBILITY_VALUES = ['always', 'unfocused'] as const;
export type CompletionSoundVisibility = (typeof COMPLETION_SOUND_VISIBILITY_VALUES)[number];
export const CHAT_MAX_WIDTH_VALUES = ['none', 'large', 'medium', 'small'] as const;
export type ChatMaxWidth = (typeof CHAT_MAX_WIDTH_VALUES)[number];
export const USER_MESSAGE_ALIGNMENT_VALUES = ['left', 'right'] as const;
export type UserMessageAlignment = (typeof USER_MESSAGE_ALIGNMENT_VALUES)[number];
export const INLINE_IMAGE_THUMBNAIL_SIZE_VALUES = ['small', 'medium', 'large', 'full'] as const;
export type InlineImageThumbnailSize = (typeof INLINE_IMAGE_THUMBNAIL_SIZE_VALUES)[number];
export const IMAGE_CACHE_SIZE_MIB_VALUES = [8, 16, 32, 64, 128, 256, 512] as const;
export type ImageCacheSizeMiB = (typeof IMAGE_CACHE_SIZE_MIB_VALUES)[number];
export const INLINE_MERMAID_THUMBNAIL_SIZE_VALUES = ['small', 'medium', 'large', 'full'] as const;
export type InlineMermaidThumbnailSize = (typeof INLINE_MERMAID_THUMBNAIL_SIZE_VALUES)[number];
export const SIDEBAR_SORT_MODE_VALUES = ['manual', 'recent'] as const;
export type SidebarSortMode = (typeof SIDEBAR_SORT_MODE_VALUES)[number];
export const WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MIN_PX = -2;
export const WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MAX_PX = 6;

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

export type FileOpenPlacementPreference = 'same-window' | 'new-window' | 'dialog';
export const FILE_OPEN_PLACEMENT_VALUES = [
	'same-window',
	'new-window',
	'dialog',
] as const satisfies readonly FileOpenPlacementPreference[];
// Auto keeps the source visible in whatever split fits; mobile always replaces the source.
export const FORK_OPEN_PLACEMENT_VALUES = [
	'split-auto',
	'split-right',
	'split-below',
	'replace',
] as const;
export type ForkOpenPlacementPreference = (typeof FORK_OPEN_PLACEMENT_VALUES)[number];
export const HIDEABLE_TOOL_GROUPS = [
	{
		id: 'bash',
		toolTypes: ['bash-tool-use', 'write-stdin-tool-use', 'claude-monitor-tool-use'],
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
			'background-task-tool-use',
			'agent-message-tool-use',
			'codex-subagent-tool-use',
			'update-plan-tool-use',
			'enter-plan-mode-tool-use',
			'antigravity-enter-plan-mode-tool-use',
			'antigravity-exit-plan-mode-tool-use',
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
			'pi-tool-search-tool-use',
			'claude-tool-search-tool-use',
		],
	},
] as const;
export type HideableToolType = (typeof HIDEABLE_TOOL_GROUPS)[number]['toolTypes'][number];

export interface LocalSettingsSnapshot extends TypographyPreferences, ComposerStatusBarPreferences {
	themePreference: ThemePreference;
	terminalAppearance: boolean;
	overlayBackdropEffects: boolean;
	highlightActiveWindow: boolean;
	collapseDelegatedChatsByDefault: boolean;
	autoExpandTools: boolean;
	combineToolUseMessages: boolean;
	alwaysExpandCliMessages: boolean;
	showThinking: boolean;
	allowDirectChats: boolean;
	reduceMotion: boolean;
	modelControlsLeft: boolean;
	autoScrollToBottom: boolean;
	sendByShiftEnter: boolean;
	composerInputMode: ComposerInputMode;
	steerWithCtrlEnter: boolean;
	snippetTrigger: string;
	chatMaxWidth: ChatMaxWidth;
	userMessageAlignment: UserMessageAlignment;
	autoHideChatScrollbar: boolean;
	inlineImageThumbnailSize: InlineImageThumbnailSize;
	imageCacheSizeMiB: ImageCacheSizeMiB;
	inlineMermaidThumbnailSize: InlineMermaidThumbnailSize;
	workspaceWindowTitlebarHeightDeltaPx: number;
	fullscreenCoversSidebar: boolean;
	chatListAutohide: boolean;
	chatListDock: ChatListDock;
	sidebarVisible: boolean;
	sidebarWidth: number;
	sidebarGroupingFields: SidebarGroupingSelection[];
	sidebarNestDelegatedChats: boolean;
	sidebarSeparateArchivedBranches: boolean;
	sidebarInactivityDuration: SidebarInactivityDuration;
	sidebarGroupNestedProjectPaths: boolean;
	sidebarChatItemLayout: ChatItemLayout;
	sidebarShowProjectPath: boolean;
	selectedChatBoardId: string | null;
	chatBoardItemLayout: ChatItemLayout | null;
	chatBoardActiveColumnByBoardId: Record<string, string>;
	sidebarSortMode: SidebarSortMode;
	sidebarSearchResultSort: ChatSearchSort;
	codeEditorWordWrap: boolean;
	codeEditorVimMode: boolean;
	codeEditorLineNumbers: boolean;
	markdownViewerFontSize: string;
	textEditorOpenPlacement: FileOpenPlacementPreference;
	imageViewerOpenPlacement: FileOpenPlacementPreference;
	markdownViewerOpenPlacement: FileOpenPlacementPreference;
	forkOpenPlacement: ForkOpenPlacementPreference;
	swapDraggedOpenChats: boolean;
	hiddenToolTypes: HideableToolType[];
	globalShortcuts: GlobalShortcutOverrides;
	browserNotifications: boolean;
	completionSoundMode: CompletionSoundMode;
	completionSoundVolume: number;
	completionSoundVisibility: CompletionSoundVisibility;
	customCompletionSoundName: string | null;
}

type BooleanPreferenceKey = {
	[K in keyof LocalSettingsSnapshot]: LocalSettingsSnapshot[K] extends boolean ? K : never;
}[keyof LocalSettingsSnapshot];
// Browser notifications require permission before enabling.
type BooleanLocalSettingKey = Exclude<BooleanPreferenceKey, 'browserNotifications'>;

const DEFAULTS: LocalSettingsSnapshot = {
	themePreference: DEFAULT_THEME_PREFERENCE,
	terminalAppearance: false,
	...TYPOGRAPHY_DEFAULTS,
	overlayBackdropEffects: true,
	highlightActiveWindow: true,
	collapseDelegatedChatsByDefault: true,
	autoExpandTools: false,
	combineToolUseMessages: true,
	alwaysExpandCliMessages: false,
	showThinking: true,
	allowDirectChats: false,
	reduceMotion: false,
	modelControlsLeft: true,
	...COMPOSER_STATUS_BAR_DEFAULTS,
	autoScrollToBottom: true,
	sendByShiftEnter: false,
	composerInputMode: 'formatted',
	steerWithCtrlEnter: true,
	snippetTrigger: DEFAULT_SNIPPET_TRIGGER,
	chatMaxWidth: 'none',
	userMessageAlignment: 'left',
	autoHideChatScrollbar: true,
	inlineImageThumbnailSize: 'medium',
	imageCacheSizeMiB: 64,
	inlineMermaidThumbnailSize: 'medium',
	workspaceWindowTitlebarHeightDeltaPx: 0,
	fullscreenCoversSidebar: true,
	chatListAutohide: false,
	chatListDock: DEFAULT_CHAT_LIST_DOCK,
	sidebarVisible: true,
	sidebarWidth: 320,
	...defaultSidebarDisplayPreferences(),
	selectedChatBoardId: null,
	chatBoardItemLayout: null,
	chatBoardActiveColumnByBoardId: {},
	sidebarSortMode: 'recent',
	sidebarSearchResultSort: 'relevance',
	codeEditorWordWrap: false,
	codeEditorVimMode: false,
	codeEditorLineNumbers: true,
	markdownViewerFontSize: '12',
	textEditorOpenPlacement: 'same-window',
	imageViewerOpenPlacement: 'same-window',
	markdownViewerOpenPlacement: 'same-window',
	forkOpenPlacement: 'split-auto',
	swapDraggedOpenChats: true,
	hiddenToolTypes: [],
	globalShortcuts: {},
	browserNotifications: false,
	completionSoundMode: 'off',
	completionSoundVolume: 0.7,
	completionSoundVisibility: 'unfocused',
	customCompletionSoundName: null,
};

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

export function isChatMaxWidth(value: unknown): value is ChatMaxWidth {
	return typeof value === 'string' && CHAT_MAX_WIDTH_VALUES.includes(value as ChatMaxWidth);
}

function parseChatMaxWidth(value: unknown): ChatMaxWidth {
	return isChatMaxWidth(value) ? value : DEFAULTS.chatMaxWidth;
}

export function isUserMessageAlignment(value: unknown): value is UserMessageAlignment {
	return (
		typeof value === 'string' &&
		USER_MESSAGE_ALIGNMENT_VALUES.includes(value as UserMessageAlignment)
	);
}

function parseUserMessageAlignment(value: unknown): UserMessageAlignment {
	return isUserMessageAlignment(value) ? value : DEFAULTS.userMessageAlignment;
}

export function isImageCacheSizeMiB(value: unknown): value is ImageCacheSizeMiB {
	return (
		typeof value === 'number' && IMAGE_CACHE_SIZE_MIB_VALUES.includes(value as ImageCacheSizeMiB)
	);
}

export function isInlineImageThumbnailSize(value: unknown): value is InlineImageThumbnailSize {
	return (
		typeof value === 'string' &&
		INLINE_IMAGE_THUMBNAIL_SIZE_VALUES.includes(value as InlineImageThumbnailSize)
	);
}

export function isInlineMermaidThumbnailSize(value: unknown): value is InlineMermaidThumbnailSize {
	return (
		typeof value === 'string' &&
		INLINE_MERMAID_THUMBNAIL_SIZE_VALUES.includes(value as InlineMermaidThumbnailSize)
	);
}

function parseSidebarWidth(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	return DEFAULTS.sidebarWidth;
}

function parseWorkspaceWindowTitlebarHeightDeltaPx(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULTS.workspaceWindowTitlebarHeightDeltaPx;
	}
	return Math.min(
		WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MAX_PX,
		Math.max(WORKSPACE_WINDOW_TITLEBAR_HEIGHT_DELTA_MIN_PX, Math.round(value)),
	);
}

function parseSidebarSortMode(value: unknown): SidebarSortMode {
	return typeof value === 'string' && SIDEBAR_SORT_MODE_VALUES.includes(value as SidebarSortMode)
		? (value as SidebarSortMode)
		: DEFAULTS.sidebarSortMode;
}

function parseSidebarSearchResultSort(value: unknown): ChatSearchSort {
	return typeof value === 'string' && CHAT_SEARCH_SORT_VALUES.includes(value as ChatSearchSort)
		? (value as ChatSearchSort)
		: DEFAULTS.sidebarSearchResultSort;
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

function parseSidebarChatItemLayout(value: unknown): ChatItemLayout {
	return parseStoredChatItemLayout(value) ?? DEFAULTS.sidebarChatItemLayout;
}

function parseChatBoardActiveColumns(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				(entry): entry is [string, string] =>
					isChatBoardId(entry[0]) && isChatBoardColumnId(entry[1]),
			)
			.slice(-CHAT_BOARD_MAX_COUNT),
	);
}

export function isFileOpenPlacement(value: unknown): value is FileOpenPlacementPreference {
	return (
		typeof value === 'string' &&
		FILE_OPEN_PLACEMENT_VALUES.includes(value as FileOpenPlacementPreference)
	);
}

export function isForkOpenPlacement(value: unknown): value is ForkOpenPlacementPreference {
	return (
		typeof value === 'string' &&
		FORK_OPEN_PLACEMENT_VALUES.includes(value as ForkOpenPlacementPreference)
	);
}

function normalizeHiddenToolTypes(value: unknown): HideableToolType[] {
	if (!Array.isArray(value)) return DEFAULTS.hiddenToolTypes;
	const selected = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
	return HIDEABLE_TOOL_GROUPS.flatMap((group) =>
		group.toolTypes.some((toolType) => selected.has(toolType)) ? [...group.toolTypes] : [],
	);
}

type SettingKey = keyof LocalSettingsSnapshot;
type SettingParsers = { [K in SettingKey]?: (value: unknown) => LocalSettingsSnapshot[K] };

const parsers: SettingParsers = {
	themePreference: parseThemePreference,
	composerInputMode: (value) => (value === 'source' ? 'source' : 'formatted'),
	snippetTrigger: normalizeSnippetTrigger,
	chatMaxWidth: parseChatMaxWidth,
	userMessageAlignment: parseUserMessageAlignment,
	inlineImageThumbnailSize: (value) =>
		isInlineImageThumbnailSize(value) ? value : DEFAULTS.inlineImageThumbnailSize,
	imageCacheSizeMiB: (value) => (isImageCacheSizeMiB(value) ? value : DEFAULTS.imageCacheSizeMiB),
	inlineMermaidThumbnailSize: (value) =>
		isInlineMermaidThumbnailSize(value) ? value : DEFAULTS.inlineMermaidThumbnailSize,
	workspaceWindowTitlebarHeightDeltaPx: parseWorkspaceWindowTitlebarHeightDeltaPx,
	chatListDock: normalizeChatListDock,
	sidebarWidth: parseSidebarWidth,
	sidebarGroupingFields: normalizeSidebarGroupingFields,
	sidebarInactivityDuration: parseSidebarInactivityDuration,
	sidebarChatItemLayout: parseSidebarChatItemLayout,
	selectedChatBoardId: (value) => (isChatBoardId(value) ? value : null),
	chatBoardItemLayout: parseStoredChatItemLayout,
	chatBoardActiveColumnByBoardId: parseChatBoardActiveColumns,
	sidebarSortMode: parseSidebarSortMode,
	sidebarSearchResultSort: parseSidebarSearchResultSort,
	textEditorOpenPlacement: (value) =>
		isFileOpenPlacement(value) ? value : DEFAULTS.textEditorOpenPlacement,
	imageViewerOpenPlacement: (value) =>
		isFileOpenPlacement(value) ? value : DEFAULTS.imageViewerOpenPlacement,
	markdownViewerOpenPlacement: (value) =>
		isFileOpenPlacement(value) ? value : DEFAULTS.markdownViewerOpenPlacement,
	forkOpenPlacement: (value) => (isForkOpenPlacement(value) ? value : DEFAULTS.forkOpenPlacement),
	hiddenToolTypes: normalizeHiddenToolTypes,
	globalShortcuts: sanitizeGlobalShortcutOverrides,
	completionSoundMode: parseCompletionSoundMode,
	completionSoundVolume: parseCompletionSoundVolume,
	completionSoundVisibility: parseCompletionSoundVisibility,
	customCompletionSoundName: (value) => (typeof value === 'string' ? value : null),
};

for (const { id, fontKey, sizeKey } of TYPOGRAPHY_SURFACES) {
	parsers[fontKey] = (value) => parseSurfaceFont(id, value);
	parsers[sizeKey] = parseFontSizePreference;
}

const SETTING_KEYS = Object.keys(DEFAULTS) as SettingKey[];

function parseSetting<K extends SettingKey>(key: K, value: unknown): LocalSettingsSnapshot[K] {
	const parse = parsers[key];
	if (parse) return parse(value);
	const fallback = DEFAULTS[key];
	return typeof value === typeof fallback ? (value as LocalSettingsSnapshot[K]) : fallback;
}

function collectSettings(
	read: <K extends SettingKey>(key: K) => LocalSettingsSnapshot[K],
): LocalSettingsSnapshot {
	const snapshot = { ...DEFAULTS };
	function collect<K extends SettingKey>(key: K): void {
		snapshot[key] = read(key);
	}
	for (const key of SETTING_KEYS) collect(key);
	return snapshot;
}

function parseFromRaw(parsed: Record<string, unknown>): LocalSettingsSnapshot {
	return collectSettings((key) => parseSetting(key, parsed[key]));
}

// Stored compound preferences are JSON values; object key order is not a setting.
function sameSetting(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, i) => sameSetting(value, right[i]));
	}
	if (
		!left ||
		!right ||
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		Array.isArray(left) ||
		Array.isArray(right)
	)
		return false;
	const entries = Object.entries(left);
	return (
		entries.length === Object.keys(right).length &&
		entries.every(
			([key, value]) => Object.hasOwn(right, key) && sameSetting(value, Reflect.get(right, key)),
		)
	);
}

function assignSetting<K extends SettingKey>(
	settings: LocalSettingsSnapshot,
	key: K,
	value: LocalSettingsSnapshot[K],
): boolean {
	if (untrack(() => sameSetting(settings[key], value))) return false;
	settings[key] = value;
	return true;
}

function readPersistedLocalSettings(): LocalSettingsSnapshot | null {
	try {
		const raw = getLocalStorageItem(LOCAL_STORAGE_KEYS.localSettings);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed) ||
			Object.keys(parsed).length === 0
		) {
			return null;
		}
		return parseFromRaw(parsed);
	} catch {
		return null;
	}
}

function persistLocalSettings(snapshot: LocalSettingsSnapshot): void {
	setLocalStorageItem(LOCAL_STORAGE_KEYS.localSettings, JSON.stringify(snapshot));
}

export class LocalSettingsStore implements LocalSettingsSnapshot {
	readonly hadSavedSettingsOnLoad: boolean;
	readonly activeCombineToolUseMessages: boolean;
	themePreference = $state.raw<ThemePreference>({ ...DEFAULTS.themePreference });
	terminalAppearance = $state(DEFAULTS.terminalAppearance);
	interfaceFont = $state(DEFAULTS.interfaceFont);
	interfaceFontSize = $state(DEFAULTS.interfaceFontSize);
	chatListFont = $state(DEFAULTS.chatListFont);
	chatListFontSize = $state(DEFAULTS.chatListFontSize);
	chatFeedFont = $state(DEFAULTS.chatFeedFont);
	chatFeedFontSize = $state(DEFAULTS.chatFeedFontSize);
	chatCodeFont = $state(DEFAULTS.chatCodeFont);
	chatCodeFontSize = $state(DEFAULTS.chatCodeFontSize);
	chatOutputFont = $state(DEFAULTS.chatOutputFont);
	chatOutputFontSize = $state(DEFAULTS.chatOutputFontSize);
	expandedEditorFont = $state(DEFAULTS.expandedEditorFont);
	expandedEditorFontSize = $state(DEFAULTS.expandedEditorFontSize);
	codeEditorFont = $state(DEFAULTS.codeEditorFont);
	codeDiffFont = $state(DEFAULTS.codeDiffFont);
	terminalFont = $state(DEFAULTS.terminalFont);
	overlayBackdropEffects = $state(DEFAULTS.overlayBackdropEffects);
	highlightActiveWindow = $state(DEFAULTS.highlightActiveWindow);
	collapseDelegatedChatsByDefault = $state(DEFAULTS.collapseDelegatedChatsByDefault);
	autoExpandTools = $state(DEFAULTS.autoExpandTools);
	combineToolUseMessages = $state(DEFAULTS.combineToolUseMessages);
	alwaysExpandCliMessages = $state(DEFAULTS.alwaysExpandCliMessages);
	showThinking = $state(DEFAULTS.showThinking);
	allowDirectChats = $state(DEFAULTS.allowDirectChats);
	reduceMotion = $state(DEFAULTS.reduceMotion);
	modelControlsLeft = $state(DEFAULTS.modelControlsLeft);
	composerStatusBarGitProjects = $state(DEFAULTS.composerStatusBarGitProjects);
	composerStatusBarNonGitProjects = $state(DEFAULTS.composerStatusBarNonGitProjects);
	composerStatusBarProjectPath = $state(DEFAULTS.composerStatusBarProjectPath);
	composerStatusBarGitBranch = $state(DEFAULTS.composerStatusBarGitBranch);
	composerStatusBarCommit = $state(DEFAULTS.composerStatusBarCommit);
	autoScrollToBottom = $state(DEFAULTS.autoScrollToBottom);
	sendByShiftEnter = $state(DEFAULTS.sendByShiftEnter);
	composerInputMode = $state<ComposerInputMode>(DEFAULTS.composerInputMode);
	steerWithCtrlEnter = $state(DEFAULTS.steerWithCtrlEnter);
	snippetTrigger = $state(DEFAULTS.snippetTrigger);
	chatMaxWidth = $state<ChatMaxWidth>(DEFAULTS.chatMaxWidth);
	userMessageAlignment = $state<UserMessageAlignment>(DEFAULTS.userMessageAlignment);
	autoHideChatScrollbar = $state(DEFAULTS.autoHideChatScrollbar);
	inlineImageThumbnailSize = $state<InlineImageThumbnailSize>(DEFAULTS.inlineImageThumbnailSize);
	imageCacheSizeMiB = $state<ImageCacheSizeMiB>(DEFAULTS.imageCacheSizeMiB);
	inlineMermaidThumbnailSize = $state<InlineMermaidThumbnailSize>(
		DEFAULTS.inlineMermaidThumbnailSize,
	);
	workspaceWindowTitlebarHeightDeltaPx = $state(DEFAULTS.workspaceWindowTitlebarHeightDeltaPx);
	fullscreenCoversSidebar = $state(DEFAULTS.fullscreenCoversSidebar);
	chatListAutohide = $state(DEFAULTS.chatListAutohide);
	chatListDock = $state<ChatListDock>(DEFAULTS.chatListDock);
	sidebarVisible = $state(DEFAULTS.sidebarVisible);
	sidebarWidth = $state(DEFAULTS.sidebarWidth);
	sidebarGroupingFields = $state.raw<SidebarGroupingSelection[]>(defaultSidebarGroupingFields());
	sidebarNestDelegatedChats = $state(DEFAULTS.sidebarNestDelegatedChats);
	sidebarSeparateArchivedBranches = $state(DEFAULTS.sidebarSeparateArchivedBranches);
	sidebarInactivityDuration = $state<SidebarInactivityDuration>(DEFAULTS.sidebarInactivityDuration);
	sidebarGroupNestedProjectPaths = $state(DEFAULTS.sidebarGroupNestedProjectPaths);
	sidebarChatItemLayout = $state<ChatItemLayout>(DEFAULTS.sidebarChatItemLayout);
	sidebarShowProjectPath = $state(DEFAULTS.sidebarShowProjectPath);
	selectedChatBoardId = $state<string | null>(DEFAULTS.selectedChatBoardId);
	chatBoardItemLayout = $state<ChatItemLayout | null>(DEFAULTS.chatBoardItemLayout);
	chatBoardActiveColumnByBoardId = $state.raw<Record<string, string>>({});
	sidebarSortMode = $state<SidebarSortMode>(DEFAULTS.sidebarSortMode);
	sidebarSearchResultSort = $state<ChatSearchSort>(DEFAULTS.sidebarSearchResultSort);
	codeEditorWordWrap = $state(DEFAULTS.codeEditorWordWrap);
	codeEditorVimMode = $state(DEFAULTS.codeEditorVimMode);
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
	forkOpenPlacement = $state<ForkOpenPlacementPreference>(DEFAULTS.forkOpenPlacement);
	swapDraggedOpenChats = $state(DEFAULTS.swapDraggedOpenChats);
	hiddenToolTypes = $state.raw<HideableToolType[]>([]);
	globalShortcuts = $state.raw<GlobalShortcutOverrides>({});
	browserNotifications = $state(DEFAULTS.browserNotifications);
	completionSoundMode = $state<CompletionSoundMode>(DEFAULTS.completionSoundMode);
	completionSoundVolume = $state(DEFAULTS.completionSoundVolume);
	completionSoundVisibility = $state<CompletionSoundVisibility>(DEFAULTS.completionSoundVisibility);
	customCompletionSoundName = $state<string | null>(DEFAULTS.customCompletionSoundName);

	#storageListener = (event: StorageEvent) => {
		if (event.storageArea !== window.localStorage) return;
		if (event.key !== null && event.key !== LOCAL_STORAGE_KEYS.localSettings) return;
		this.#apply(readPersistedLocalSettings() ?? parseFromRaw({}));
	};

	constructor() {
		const initial = readPersistedLocalSettings();
		this.hadSavedSettingsOnLoad = initial !== null;
		if (initial) this.#apply(initial);
		this.activeCombineToolUseMessages = this.combineToolUseMessages;
		if (typeof window !== 'undefined') {
			window.addEventListener('storage', this.#storageListener);
		}
	}

	destroy(): void {
		if (typeof window !== 'undefined') {
			window.removeEventListener('storage', this.#storageListener);
		}
	}

	save(): void {
		persistLocalSettings(untrack(() => this.#readSettings()));
	}

	set<K extends SettingKey>(key: K, value: LocalSettingsSnapshot[K]): void {
		if (assignSetting(this, key, parseSetting(key, value))) this.save();
	}

	setTypography(surface: TypographySurface, font: FontPreference, size: FontSizePreference): void {
		const { fontKey, sizeKey } = getTypographySurface(surface);
		const changedFont = assignSetting(this, fontKey, parseSurfaceFont(surface, font));
		const changedSize = assignSetting(this, sizeKey, parseFontSizePreference(size));
		if (changedFont || changedSize) this.save();
	}

	setSidebarDisplay({
		sidebarGroupingFields,
		sidebarNestDelegatedChats,
		sidebarSeparateArchivedBranches,
		sidebarInactivityDuration,
		sidebarGroupNestedProjectPaths,
		sidebarChatItemLayout,
		sidebarShowProjectPath,
	}: SidebarDisplayPreferences): void {
		if (
			this.#apply({
				sidebarGroupingFields: normalizeSidebarGroupingFields(sidebarGroupingFields),
				sidebarNestDelegatedChats: Boolean(sidebarNestDelegatedChats),
				sidebarSeparateArchivedBranches: Boolean(sidebarSeparateArchivedBranches),
				sidebarInactivityDuration,
				sidebarGroupNestedProjectPaths,
				sidebarChatItemLayout,
				sidebarShowProjectPath,
			})
		)
			this.save();
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

	pruneChatBoardActiveColumns(boards: readonly ChatBoard[]): void {
		const columnsByBoardId = new Map(
			boards.map((board) => [board.id, new Set(board.columns.map((column) => column.id))]),
		);
		const retained = Object.fromEntries(
			Object.entries(this.chatBoardActiveColumnByBoardId).filter(([boardId, columnId]) =>
				columnsByBoardId.get(boardId)?.has(columnId),
			),
		);
		if (Object.keys(retained).length === Object.keys(this.chatBoardActiveColumnByBoardId).length) {
			return;
		}
		this.set('chatBoardActiveColumnByBoardId', retained);
	}

	snapshot(): LocalSettingsSnapshot {
		const snapshot = this.#readSettings();
		return {
			...snapshot,
			themePreference: { ...snapshot.themePreference },
			sidebarGroupingFields: snapshot.sidebarGroupingFields.map((entry) => ({ ...entry })),
			chatBoardActiveColumnByBoardId: { ...snapshot.chatBoardActiveColumnByBoardId },
			hiddenToolTypes: [...snapshot.hiddenToolTypes],
			globalShortcuts: { ...snapshot.globalShortcuts },
		};
	}

	#readSettings(): LocalSettingsSnapshot {
		return collectSettings((key) => this[key]);
	}

	#apply(snapshot: Partial<LocalSettingsSnapshot>): boolean {
		let changed = false;
		for (const key of Object.keys(snapshot) as SettingKey[]) {
			const value = snapshot[key];
			if (value !== undefined && assignSetting(this, key, value)) changed = true;
		}
		return changed;
	}
}

export function createLocalSettingsStore(): LocalSettingsStore {
	return new LocalSettingsStore();
}
