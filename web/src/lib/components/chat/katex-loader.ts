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

/** Renders a bounded TeX expression to KaTeX HTML and MathML. */
export async function renderMath(source: string, displayMode: boolean): Promise<string> {
	if (source.length > MAX_MATH_SOURCE_LENGTH) {
		throw new Error('Math expression exceeds the render limit.');
	}

	const katex = await loadKatex();
	return katex.renderToString(source, {
		...BASE_RENDER_OPTIONS,
		displayMode,
	});
}
