import type { KatexOptions } from 'katex';

type Katex = typeof import('katex').default;

export const MAX_MATH_SOURCE_LENGTH = 10_000;

const BASE_RENDER_OPTIONS = {
	output: 'htmlAndMathml',
	throwOnError: true,
	trust: false,
	maxSize: 20,
	maxExpand: 1_000,
	strict: 'ignore',
	errorColor: 'hsl(var(--destructive))',
} satisfies KatexOptions;

let loadPromise: Promise<Katex> | null = null;
const mathCache = new Map<string, string>();
const MAX_CACHED_EXPRESSIONS = 128;
const MAX_CACHED_HTML_LENGTH = 16_000;

function mathKey(source: string, displayMode: boolean): string {
	return `${Number(displayMode)}${source}`;
}

export function readCachedMath(source: string, displayMode: boolean): string | undefined {
	if (source.length > MAX_MATH_SOURCE_LENGTH) return;
	const key = mathKey(source, displayMode);
	const cached = mathCache.get(key);
	if (cached === undefined) return;
	mathCache.delete(key);
	mathCache.set(key, cached);
	return cached;
}

async function loadKatex(): Promise<Katex> {
	if (!loadPromise) {
		loadPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
			.then(([{ default: katex }]) => katex)
			.catch((error: unknown) => {
				loadPromise = null;
				throw error;
			});
	}

	return loadPromise;
}

/**
 * Resolves once the lazy KaTeX module has settled, or immediately when no render
 * has been requested yet. Lets tests await the real loader deterministically
 * instead of polling wall-clock time.
 */
export function whenMathRendererReady(): Promise<void> {
	return loadPromise ? loadPromise.then(
		() => undefined,
		() => undefined,
	) : Promise.resolve();
}

/** Renders a bounded TeX expression to KaTeX HTML and MathML. */
export async function renderMath(source: string, displayMode: boolean): Promise<string> {
	if (source.length > MAX_MATH_SOURCE_LENGTH) {
		throw new Error('Math expression exceeds the render limit.');
	}

	const cached = readCachedMath(source, displayMode);
	if (cached !== undefined) return cached;
	const katex = await loadKatex();
	const shared = readCachedMath(source, displayMode);
	if (shared !== undefined) return shared;
	const html = katex.renderToString(source, {
		...BASE_RENDER_OPTIONS,
		displayMode,
	});
	if (html.length <= MAX_CACHED_HTML_LENGTH) {
		if (mathCache.size >= MAX_CACHED_EXPRESSIONS) mathCache.delete(mathCache.keys().next().value!);
		mathCache.set(mathKey(source, displayMode), html);
	}
	return html;
}
