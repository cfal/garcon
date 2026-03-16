// Lazy loader for mermaid with single-init and render caching.
// Shares one import promise across all MermaidBlock instances and
// only calls mermaid.initialize() when the theme changes.

import type { MermaidConfig } from 'mermaid';

type Mermaid = typeof import('mermaid').default;

let loadPromise: Promise<Mermaid> | null = null;
let initializedTheme: string | null = null;

const svgCache = new Map<string, string>();
const MAX_CACHE_SIZE = 64;

// Deduplicates concurrent renders of identical source.
const inflightRenders = new Map<string, Promise<string>>();

function detectTheme(): 'dark' | 'default' {
	return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

/** Loads mermaid once and re-initializes only on theme change. */
async function getMermaid(): Promise<Mermaid> {
	if (!loadPromise) {
		loadPromise = import('mermaid').then(({ default: m }) => m);
	}

	const mermaid = await loadPromise;
	const theme = detectTheme();

	if (initializedTheme !== theme) {
		const config: MermaidConfig = {
			startOnLoad: false,
			theme,
			fontFamily: 'inherit',
			suppressErrorRendering: true
		};
		mermaid.initialize(config);
		initializedTheme = theme;
		svgCache.clear();
	}

	return mermaid;
}

let renderCounter = 0;

/** Renders a mermaid diagram, returning cached SVG when available. */
export async function renderMermaid(source: string): Promise<string> {
	// Resolve mermaid first so theme changes invalidate the cache
	// before the lookup.
	const mermaid = await getMermaid();

	const cached = svgCache.get(source);
	if (cached) return cached;

	const inflight = inflightRenders.get(source);
	if (inflight) return inflight;

	const promise = (async () => {
		const id = `mermaid-${++renderCounter}-${Date.now()}`;
		const { svg } = await mermaid.render(id, source);

		if (svgCache.size >= MAX_CACHE_SIZE) {
			const oldest = svgCache.keys().next().value;
			if (oldest !== undefined) svgCache.delete(oldest);
		}
		svgCache.set(source, svg);
		return svg;
	})();

	inflightRenders.set(source, promise);
	try {
		return await promise;
	} finally {
		inflightRenders.delete(source);
	}
}
