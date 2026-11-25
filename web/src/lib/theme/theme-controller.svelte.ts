import { untrack } from 'svelte';
import {
	TYPOGRAPHY_SURFACES,
	typographyScale,
	typographyFontOverride,
	type TypographyPreferences,
} from './typography.js';
import {
	getThemeProfile,
	resolveThemeId,
	DEFAULT_THEME_PREFERENCE,
	type ColorScheme,
	type ThemeId,
	type ThemePreference,
	type ThemeProfile,
	type ThemeRendererPresentation,
	type TerminalThemeColors,
} from './themes.js';
import { applyThemeToDocument, hasResolvedThemeStyles, readTerminalColors } from './theme-dom.js';
import { loadThemeStyles } from './theme-styles.js';

const SYSTEM_DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeControllerDeps {
	readonly getPreference: () => ThemePreference;
	readonly getTerminalAppearance: () => boolean;
	readonly typography: TypographyPreferences;
	readonly setTerminalPresentation: (
		presentation: ThemeRendererPresentation & TerminalThemeColors,
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
	#appliedProfile = $state.raw<ThemeProfile>();
	#stylesheetRetry = $state(0);
	#reportedMissingTerminalThemeIds = new Set<ThemeId>();

	constructor(private readonly deps: ThemeControllerDeps) {
		for (const { id, fontKey, sizeKey } of TYPOGRAPHY_SURFACES) {
			$effect(() => {
				const root = document.documentElement;
				const font = this.deps.typography[fontKey];
				const size = this.deps.typography[sizeKey];
				if (root.getAttribute(`data-${id}-font`) !== font) {
					const override = `--${id}-font-override`;
					if (font === 'default') root.style.removeProperty(override);
					else root.style.setProperty(override, typographyFontOverride(id, font));
					root.setAttribute(`data-${id}-font`, font);
				}
				if (root.getAttribute(`data-${id}-font-size`) !== size) {
					const override = `--${id}-font-size`;
					if (size === 'default') root.style.removeProperty(override);
					else root.style.setProperty(override, `${size}px`);
					root.style.setProperty(`--${id}-font-scale`, String(typographyScale(id, size)));
					root.setAttribute(`data-${id}-font-size`, size);
				}
			});
		}

		$effect(() => {
			document.documentElement.dataset.themeAppearance = this.deps.getTerminalAppearance()
				? 'terminal'
				: 'standard';
		});

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
			const profile = this.#profile;
			void this.#stylesheetRetry;
			const loading = loadThemeStyles(profile.id);
			if (!loading) {
				untrack(() => this.#applyProfile(profile));
				return;
			}
			let current = true;
			const retry = () => this.#stylesheetRetry++;
			void loading.then(
				() => {
					if (current) this.#applyProfile(profile);
				},
				(error: unknown) => {
					if (!current) return;
					window.addEventListener('online', retry, { once: true });
					this.deps.reportError(String(error));
					if (!this.#appliedProfile) {
						this.#applyProfile(
							getThemeProfile(resolveThemeId(DEFAULT_THEME_PREFERENCE, profile.colorScheme)),
						);
					}
				},
			);
			return () => {
				current = false;
				window.removeEventListener('online', retry);
			};
		});
	}

	#applyProfile(profile: ThemeProfile): void {
		if (this.#appliedProfile === profile) return;
		this.#appliedProfile = profile;
		applyThemeToDocument(document, profile);
		const presentation: ThemeRendererPresentation = {
			colorScheme: profile.colorScheme,
			rendererPalette: profile.rendererPalette,
		};
		const terminalColors = readTerminalColors(document.documentElement);
		if (terminalColors) {
			this.deps.setTerminalPresentation({ ...presentation, ...terminalColors });
		} else if (
			hasResolvedThemeStyles(document.documentElement) &&
			!this.#reportedMissingTerminalThemeIds.has(profile.id)
		) {
			this.#reportedMissingTerminalThemeIds.add(profile.id);
			this.deps.reportError(`Theme ${profile.id} has invalid terminal color tokens`);
		}
		this.deps.setEditorPresentation(presentation);
	}

	get profile(): ThemeProfile {
		return this.#appliedProfile ?? this.#profile;
	}
}
