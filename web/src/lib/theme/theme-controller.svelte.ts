import { untrack } from 'svelte';
import {
	getThemeProfile,
	resolveThemeId,
	type ColorScheme,
	type ThemeId,
	type ThemePreference,
	type ThemeProfile,
	type ThemeRendererPresentation,
} from './themes.js';
import {
	applyThemeToDocument,
	hasResolvedThemeStyles,
	readTerminalBackground,
} from './theme-dom.js';

const SYSTEM_DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeControllerDeps {
	readonly getPreference: () => ThemePreference;
	readonly setTerminalPresentation: (
		presentation: ThemeRendererPresentation & { readonly background: string },
	) => void;
	readonly setEditorPresentation: (presentation: ThemeRendererPresentation) => void;
	readonly reportError: (message: string) => void;
}

function colorSchemeFromMediaQuery(media: Pick<MediaQueryList, 'matches'>): ColorScheme {
	return media.matches ? 'dark' : 'light';
}

function readSystemColorScheme(): ColorScheme {
	return colorSchemeFromMediaQuery(window.matchMedia(SYSTEM_DARK_MODE_QUERY));
}

export class ThemeController {
	#systemColorScheme = $state<ColorScheme>(readSystemColorScheme());
	#profile = $derived.by(() =>
		getThemeProfile(resolveThemeId(this.deps.getPreference(), this.#systemColorScheme)),
	);
	#reportedMissingTerminalThemeIds = new Set<ThemeId>();

	constructor(private readonly deps: ThemeControllerDeps) {
		$effect(() => {
			if (this.deps.getPreference().mode !== 'system') return;
			const media = window.matchMedia(SYSTEM_DARK_MODE_QUERY);
			const update = () => {
				this.#systemColorScheme = colorSchemeFromMediaQuery(media);
			};
			update();
			media.addEventListener('change', update);
			return () => media.removeEventListener('change', update);
		});

		$effect(() => {
			const profile = this.profile;
			applyThemeToDocument(document, profile);
			const presentation: ThemeRendererPresentation = {
				colorScheme: profile.colorScheme,
				rendererPalette: profile.rendererPalette,
			};
			const terminalBackground = readTerminalBackground(document.documentElement);
			untrack(() => {
				if (terminalBackground) {
					this.deps.setTerminalPresentation({ ...presentation, background: terminalBackground });
				} else if (
					hasResolvedThemeStyles(document.documentElement) &&
					!this.#reportedMissingTerminalThemeIds.has(profile.id)
				) {
					this.#reportedMissingTerminalThemeIds.add(profile.id);
					this.deps.reportError(`Theme ${profile.id} has an invalid --terminal-bg token`);
				}
				this.deps.setEditorPresentation(presentation);
			});
		});
	}

	get profile(): ThemeProfile {
		return this.#profile;
	}
}
