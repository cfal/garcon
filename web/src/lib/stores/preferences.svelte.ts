// Reactive preferences store using Svelte 5 runes. Persists user
// preferences to localStorage under a consistent key prefix.

import type { SessionProvider } from '$lib/types/app';
import type { PermissionMode } from '$lib/types/chat';

export interface ModelOption {
	value: string;
	label: string;
}

// Persisted preference fields. providerModels is runtime-only and
// excluded from persistence.
export type ThemeMode = 'dark' | 'light' | 'system';

export interface PreferencesState {
	theme: ThemeMode;
	autoExpandTools: boolean;
	showThinking: boolean;
	autoScrollToBottom: boolean;
	sendByShiftEnter: boolean;
	showChatHeader: boolean;
	alwaysFullscreenOnGitPanel: boolean;
	sidebarVisible: boolean;
	selectedProvider: SessionProvider;
	claudeModel: string;
	codexModel: string;
	opencodeModel: string;
	codeEditorTheme: string;
	codeEditorWordWrap: boolean;
	codeEditorLineNumbers: boolean;
	codeEditorFontSize: string;
	markdownViewerFontSize: string;
	language: string;
}

const STORAGE_KEY = 'pref_preferences';

const DEFAULTS: PreferencesState = {
	theme: 'system',
	autoExpandTools: false,
	showThinking: true,
	autoScrollToBottom: true,
	sendByShiftEnter: false,
	showChatHeader: false,
	alwaysFullscreenOnGitPanel: true,
	sidebarVisible: true,
	selectedProvider: 'claude',
	claudeModel: 'opus',
	codexModel: 'gpt-5.3-codex',
	opencodeModel: 'anthropic/claude-sonnet-4-5',
	codeEditorTheme: 'auto',
	codeEditorWordWrap: false,
	codeEditorLineNumbers: true,
	codeEditorFontSize: '12',
	markdownViewerFontSize: '12',
	language: 'en',
};

function readPersisted(): PreferencesState {
	if (typeof window === 'undefined') return { ...DEFAULTS };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				return {
					theme:
						typeof parsed.theme === 'string' && ['dark', 'light', 'system'].includes(parsed.theme)
							? (parsed.theme as ThemeMode)
							: DEFAULTS.theme,
					autoExpandTools:
						typeof parsed.autoExpandTools === 'boolean'
							? parsed.autoExpandTools
							: DEFAULTS.autoExpandTools,
					showThinking:
						typeof parsed.showThinking === 'boolean'
							? parsed.showThinking
							: DEFAULTS.showThinking,
					autoScrollToBottom:
						typeof parsed.autoScrollToBottom === 'boolean'
							? parsed.autoScrollToBottom
							: DEFAULTS.autoScrollToBottom,
					sendByShiftEnter:
						typeof parsed.sendByShiftEnter === 'boolean'
							? parsed.sendByShiftEnter
							: DEFAULTS.sendByShiftEnter,
					showChatHeader:
						typeof parsed.showChatHeader === 'boolean'
							? parsed.showChatHeader
							: DEFAULTS.showChatHeader,
					alwaysFullscreenOnGitPanel:
						typeof parsed.alwaysFullscreenOnGitPanel === 'boolean'
							? parsed.alwaysFullscreenOnGitPanel
							: DEFAULTS.alwaysFullscreenOnGitPanel,
					sidebarVisible:
						typeof parsed.sidebarVisible === 'boolean'
							? parsed.sidebarVisible
							: DEFAULTS.sidebarVisible,
					selectedProvider:
						typeof parsed.selectedProvider === 'string'
							? (parsed.selectedProvider as SessionProvider)
							: DEFAULTS.selectedProvider,
					claudeModel:
						typeof parsed.claudeModel === 'string'
							? parsed.claudeModel
							: DEFAULTS.claudeModel,
					codexModel:
						typeof parsed.codexModel === 'string'
							? parsed.codexModel
							: DEFAULTS.codexModel,
					opencodeModel:
						typeof parsed.opencodeModel === 'string'
							? parsed.opencodeModel
							: DEFAULTS.opencodeModel,
					codeEditorTheme:
						typeof parsed.codeEditorTheme === 'string'
							? parsed.codeEditorTheme
							: DEFAULTS.codeEditorTheme,
					codeEditorWordWrap:
						typeof parsed.codeEditorWordWrap === 'boolean'
							? parsed.codeEditorWordWrap
							: DEFAULTS.codeEditorWordWrap,
					codeEditorLineNumbers:
						typeof parsed.codeEditorLineNumbers === 'boolean'
							? parsed.codeEditorLineNumbers
							: DEFAULTS.codeEditorLineNumbers,
					codeEditorFontSize:
						typeof parsed.codeEditorFontSize === 'string'
							? parsed.codeEditorFontSize
							: DEFAULTS.codeEditorFontSize,
					markdownViewerFontSize:
						typeof parsed.markdownViewerFontSize === 'string'
							? parsed.markdownViewerFontSize
							: DEFAULTS.markdownViewerFontSize,
					language:
						typeof parsed.language === 'string'
							? parsed.language
							: DEFAULTS.language,
				};
			}
		}
	} catch {
		// Fall through to defaults
	}
	return { ...DEFAULTS };
}

function persist(state: PreferencesState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Storage full or unavailable
	}
}

export class PreferencesStore {
	theme = $state<ThemeMode>(DEFAULTS.theme);
	autoExpandTools = $state(DEFAULTS.autoExpandTools);
	showThinking = $state(DEFAULTS.showThinking);
	autoScrollToBottom = $state(DEFAULTS.autoScrollToBottom);
	sendByShiftEnter = $state(DEFAULTS.sendByShiftEnter);
	showChatHeader = $state(DEFAULTS.showChatHeader);
	alwaysFullscreenOnGitPanel = $state(DEFAULTS.alwaysFullscreenOnGitPanel);
	sidebarVisible = $state(DEFAULTS.sidebarVisible);
	selectedProvider = $state<SessionProvider>(DEFAULTS.selectedProvider);
	claudeModel = $state(DEFAULTS.claudeModel);
	codexModel = $state(DEFAULTS.codexModel);
	opencodeModel = $state(DEFAULTS.opencodeModel);
	codeEditorTheme = $state(DEFAULTS.codeEditorTheme);
	codeEditorWordWrap = $state(DEFAULTS.codeEditorWordWrap);
	codeEditorLineNumbers = $state(DEFAULTS.codeEditorLineNumbers);
	codeEditorFontSize = $state(DEFAULTS.codeEditorFontSize);
	markdownViewerFontSize = $state(DEFAULTS.markdownViewerFontSize);
	language = $state(DEFAULTS.language);

	// Runtime-only, not persisted
	providerModels = $state<Partial<Record<SessionProvider, ModelOption[]>>>({});
	lastPermissionMode = $state<PermissionMode>('default');

	constructor() {
		const saved = readPersisted();
		this.theme = saved.theme;
		this.autoExpandTools = saved.autoExpandTools;
		this.showThinking = saved.showThinking;
		this.autoScrollToBottom = saved.autoScrollToBottom;
		this.sendByShiftEnter = saved.sendByShiftEnter;
		this.showChatHeader = saved.showChatHeader;
		this.alwaysFullscreenOnGitPanel = saved.alwaysFullscreenOnGitPanel;
		this.sidebarVisible = saved.sidebarVisible;
		this.selectedProvider = saved.selectedProvider;
		this.claudeModel = saved.claudeModel;
		this.codexModel = saved.codexModel;
		this.opencodeModel = saved.opencodeModel;
		this.codeEditorTheme = saved.codeEditorTheme;
		this.codeEditorWordWrap = saved.codeEditorWordWrap;
		this.codeEditorLineNumbers = saved.codeEditorLineNumbers;
		this.codeEditorFontSize = saved.codeEditorFontSize;
		this.markdownViewerFontSize = saved.markdownViewerFontSize;
		this.language = saved.language;
	}

	/** Returns a snapshot of the persisted fields. */
	private snapshot(): PreferencesState {
		return {
			theme: this.theme,
			autoExpandTools: this.autoExpandTools,
			showThinking: this.showThinking,
			autoScrollToBottom: this.autoScrollToBottom,
			sendByShiftEnter: this.sendByShiftEnter,
			showChatHeader: this.showChatHeader,
			alwaysFullscreenOnGitPanel: this.alwaysFullscreenOnGitPanel,
			sidebarVisible: this.sidebarVisible,
			selectedProvider: this.selectedProvider,
			claudeModel: this.claudeModel,
			codexModel: this.codexModel,
			opencodeModel: this.opencodeModel,
			codeEditorTheme: this.codeEditorTheme,
			codeEditorWordWrap: this.codeEditorWordWrap,
			codeEditorLineNumbers: this.codeEditorLineNumbers,
			codeEditorFontSize: this.codeEditorFontSize,
			markdownViewerFontSize: this.markdownViewerFontSize,
			language: this.language,
		};
	}

	/** Writes all persisted fields to localStorage. */
	private save(): void {
		persist(this.snapshot());
	}

	/** Narrows dynamic-key assignment to PreferencesState keys/values
	 *  instead of the broader Record<string, unknown>. */
	private assignField(key: keyof PreferencesState, value: PreferencesState[keyof PreferencesState]): void {
		(this as unknown as Record<keyof PreferencesState, PreferencesState[keyof PreferencesState]>)[key] = value;
	}

	/** Sets a single persisted preference and saves. */
	setPreference<K extends keyof PreferencesState>(key: K, value: PreferencesState[K]): void {
		this.assignField(key, value);
		this.save();
	}

	/** Applies multiple preference updates at once and saves. */
	setPreferences(updates: Partial<PreferencesState>): void {
		for (const [key, value] of Object.entries(updates)) {
			this.assignField(key as keyof PreferencesState, value as PreferencesState[keyof PreferencesState]);
		}
		this.save();
	}

	/** Resets all persisted preferences to defaults, with optional overrides. */
	resetPreferences(overrides?: Partial<PreferencesState>): void {
		const reset = { ...DEFAULTS, ...(overrides || {}) };
		for (const [key, value] of Object.entries(reset)) {
			this.assignField(key as keyof PreferencesState, value as PreferencesState[keyof PreferencesState]);
		}
		this.save();
	}

	/** Updates the last-used permission mode. */
	setLastPermissionMode(mode: PermissionMode): void {
		this.lastPermissionMode = mode;
	}

	/** Adds or replaces the live model list for a given provider. */
	setProviderModels(provider: SessionProvider, models: ModelOption[]): void {
		this.providerModels = { ...this.providerModels, [provider]: models };
	}
}

export function createPreferencesStore(): PreferencesStore {
	return new PreferencesStore();
}
