export const FONT_OPTIONS = ['default', 'departure-mono'] as const;
export type FontPreference = (typeof FONT_OPTIONS)[number];

export function parseFontPreference(value: unknown): FontPreference {
	return value === 'departure-mono' ? value : 'default';
}

export function observeFontChanges(
	root: Document,
	onChange: () => void,
	attributes = ['data-interface-font', 'data-monospace-font'],
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
const FONT_LOAD_TIMEOUT_MS = 4_000;
let departureLoad: Promise<boolean> | undefined;

export function loadDepartureMono(): Promise<boolean> {
	departureLoad ??= loadDepartureFace();
	return departureLoad;
}

async function loadDepartureFace(): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			document.fonts
				.load(`400 16px ${DEPARTURE_MONO_FAMILY}`)
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
