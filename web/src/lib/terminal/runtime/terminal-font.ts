const TERMINAL_FONT_NAME = 'Monaspace Neon NF';
const TERMINAL_FONT_LOAD_TIMEOUT_MS = 4_000;
const MONASPACE_RELEASE_COMMIT = 'f31794b6e9e65698a062262e2f826f679dcb7070';
const MONASPACE_CDN_DIRECTORY =
	`https://cdn.jsdelivr.net/gh/githubnext/monaspace@${MONASPACE_RELEASE_COMMIT}` +
	'/fonts/Web%20Fonts/NerdFonts%20Web%20Fonts/Monaspace%20Neon';
const TERMINAL_FONT_SOURCES = [
	{ url: `${MONASPACE_CDN_DIRECTORY}/MonaspaceNeonNF-Regular.woff2`, weight: '400' },
	{ url: `${MONASPACE_CDN_DIRECTORY}/MonaspaceNeonNF-Bold.woff2`, weight: '700' },
] as const;

export const TERMINAL_FALLBACK_FONT_FAMILY =
	'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
export const TERMINAL_FONT_FAMILY = `"${TERMINAL_FONT_NAME}", ${TERMINAL_FALLBACK_FONT_FAMILY}`;

export type TerminalFontFamily = typeof TERMINAL_FONT_FAMILY | typeof TERMINAL_FALLBACK_FONT_FAMILY;

type TerminalFontFaceFactory = () => readonly FontFace[];
type FontFaceRegistrar = (fontFace: FontFace) => void;

export interface TerminalFontResolver {
	load(): Promise<TerminalFontFamily>;
}

export class TerminalFontLoader implements TerminalFontResolver {
	readonly #createFontFaces: TerminalFontFaceFactory;
	readonly #registerFontFace: FontFaceRegistrar;
	readonly #timeoutMs: number;
	#loadPromise: Promise<TerminalFontFamily> | null = null;

	constructor(
		createFontFaces: TerminalFontFaceFactory = () =>
			TERMINAL_FONT_SOURCES.map(
				({ url, weight }) =>
					new FontFace(TERMINAL_FONT_NAME, `url(${JSON.stringify(url)}) format("woff2")`, {
						style: 'normal',
						weight,
					}),
			),
		registerFontFace: FontFaceRegistrar = (fontFace) => document.fonts.add(fontFace),
		timeoutMs = TERMINAL_FONT_LOAD_TIMEOUT_MS,
	) {
		this.#createFontFaces = createFontFaces;
		this.#registerFontFace = registerFontFace;
		this.#timeoutMs = timeoutMs;
	}

	load(): Promise<TerminalFontFamily> {
		// Shares one browser font request across every terminal runtime.
		this.#loadPromise ??= this.#loadOnce();
		return this.#loadPromise;
	}

	async #loadOnce(): Promise<TerminalFontFamily> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const fontFaces = this.#createFontFaces();
			const loadedFontFaces = await Promise.race([
				Promise.all(fontFaces.map((fontFace) => fontFace.load())),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error('Terminal font load timed out')),
						this.#timeoutMs,
					);
				}),
			]);
			for (const fontFace of loadedFontFaces) this.#registerFontFace(fontFace);
			return TERMINAL_FONT_FAMILY;
		} catch {
			return TERMINAL_FALLBACK_FONT_FAMILY;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
}

export const terminalFontLoader = new TerminalFontLoader();
