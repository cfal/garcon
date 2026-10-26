export const FONT_OPTIONS = [
	'default',
	'system-sans',
	'system-serif',
	'system-mono',
	'departure-mono',
	'jetbrains-mono',
	'inter',
] as const;
export type FontPreference = (typeof FONT_OPTIONS)[number];

export function parseFontPreference(value: unknown): FontPreference {
	return FONT_OPTIONS.find((font) => font === value) ?? 'default';
}

export function isMonospaceFont(
	font: FontPreference,
): font is 'default' | 'system-mono' | 'departure-mono' | 'jetbrains-mono' {
	return (
		font === 'default' ||
		font === 'system-mono' ||
		font === 'departure-mono' ||
		font === 'jetbrains-mono'
	);
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

export const DEPARTURE_MONO_FAMILY = '"Departure Mono"';
export const BUNDLED_FONT_FAMILIES = {
	'departure-mono': DEPARTURE_MONO_FAMILY,
	'jetbrains-mono': '"JetBrains Mono"',
	inter: '"Inter"',
} as const;
const FONT_LOAD_TIMEOUT_MS = 4_000;
const fontLoads = new Map<FontPreference, Promise<boolean>>();

export function loadFont(font: FontPreference): Promise<boolean> {
	if (!Object.hasOwn(BUNDLED_FONT_FAMILIES, font)) return Promise.resolve(true);
	let pending = fontLoads.get(font);
	if (!pending) {
		pending = loadFace(BUNDLED_FONT_FAMILIES[font as keyof typeof BUNDLED_FONT_FAMILIES]);
		fontLoads.set(font, pending);
	}
	return pending;
}

async function loadFace(family: string): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			document.fonts
				.load(`400 16px ${family}`)
				.then((faces) => faces.some((face) => face.status === 'loaded')),
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
