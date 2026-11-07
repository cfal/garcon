export const SYSTEM_EDITOR_FONT =
	'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

export const FONT_OPTIONS = [
	'default',
	'system-sans',
	'system-serif',
	'system-mono',
	'departure-mono',
	'jetbrains-mono',
	'inter',
	'source-sans-3',
	'atkinson-hyperlegible',
	'source-serif-4',
	'ibm-plex-mono',
	'source-code-pro',
	'arimo',
	'roboto',
] as const;
export type FontPreference = (typeof FONT_OPTIONS)[number];

const MONOSPACE_FONTS = [
	'default',
	'system-mono',
	'departure-mono',
	'jetbrains-mono',
	'ibm-plex-mono',
	'source-code-pro',
] as const satisfies readonly FontPreference[];

export function parseFontPreference(value: unknown): FontPreference {
	return FONT_OPTIONS.find((font) => font === value) ?? 'default';
}

export function isMonospaceFont(font: FontPreference): font is (typeof MONOSPACE_FONTS)[number] {
	return MONOSPACE_FONTS.some((choice) => choice === font);
}

export function observeFontChanges(
	root: Document,
	onChange: () => void,
	attributes: string[],
): () => void {
	const observer = new MutationObserver(onChange);
	observer.observe(root.documentElement, { attributes: true, attributeFilter: attributes });
	root.fonts?.addEventListener('loadingdone', onChange);
	return () => {
		observer.disconnect();
		root.fonts?.removeEventListener('loadingdone', onChange);
	};
}

export const BUNDLED_FONT_FAMILIES = {
	'departure-mono': '"Departure Mono"',
	'jetbrains-mono': '"JetBrains Mono"',
	inter: '"Inter"',
	'source-sans-3': '"Source Sans 3"',
	'atkinson-hyperlegible': '"Atkinson Hyperlegible"',
	'source-serif-4': '"Source Serif 4"',
	'ibm-plex-mono': '"IBM Plex Mono"',
	'source-code-pro': '"Source Code Pro"',
	arimo: '"Arimo"',
	// Avoids intercepting platform Roboto in the system UI fallback stack.
	roboto: '"Garcon Roboto"',
} as const;
export type BundledFont = keyof typeof BUNDLED_FONT_FAMILIES;

export function isBundledFont(font: FontPreference): font is BundledFont {
	return Object.hasOwn(BUNDLED_FONT_FAMILIES, font);
}

const FONT_LOAD_TIMEOUT_MS = 4_000;
const fontLoads = new Map<FontPreference, Promise<boolean>>();

export function loadFont(font: FontPreference): Promise<boolean> {
	if (!isBundledFont(font)) return Promise.resolve(true);
	let pending = fontLoads.get(font);
	if (!pending) {
		pending = loadFaces(BUNDLED_FONT_FAMILIES[font]).then((loaded) => {
			if (!loaded) fontLoads.delete(font);
			return loaded;
		});
		fontLoads.set(font, pending);
	}
	return pending;
}

async function loadFaces(family: string): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			// Loads real bold/italic faces before canvas terminals cache fallback glyphs.
			Promise.all(
				['400', '700', 'italic 400', 'italic 700'].map((style) =>
					document.fonts.load(`${style} 16px ${family}`),
				),
			).then((variants) =>
				variants.every((faces) => faces.some((face) => face.status === 'loaded')),
			),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(false), FONT_LOAD_TIMEOUT_MS);
			}),
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}
