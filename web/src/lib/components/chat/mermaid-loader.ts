import type { MermaidConfig } from 'mermaid';
import {
	rendererThemeIdFor,
	type RendererThemeId,
	type ThemeRendererPresentation,
} from '$lib/theme/themes.js';

type Mermaid = typeof import('mermaid').default;
export type MermaidThemeId = RendererThemeId;

const THEME_CONFIGS: Record<MermaidThemeId, MermaidConfig> = {
	'standard-light': {
		startOnLoad: false,
		securityLevel: 'strict',
		theme: 'default',
		fontFamily: 'inherit',
		suppressErrorRendering: true,
		themeVariables: {
			primaryTextColor: '#111827',
			textColor: '#111827',
			taskTextColor: '#1f2937',
			taskTextDarkColor: '#1f2937',
			taskTextOutsideColor: '#1f2937',
			taskBkgColor: '#bfdbfe',
			activeTaskBkgColor: '#bfdbfe',
			activeTaskBorderColor: '#1d4ed8',
			doneTaskBkgColor: '#d1d5db',
			doneTaskBorderColor: '#4b5563',
			critBkgColor: '#fed7aa',
			critBorderColor: '#c2410c',
			sectionBkgColor: '#dbeafe',
			sectionBkgColor2: '#e5e7eb',
		},
	},
	'standard-dark': {
		startOnLoad: false,
		securityLevel: 'strict',
		theme: 'dark',
		fontFamily: 'inherit',
		suppressErrorRendering: true,
		themeVariables: {
			primaryTextColor: '#f3f4f6',
			textColor: '#f3f4f6',
			taskTextColor: '#f9fafb',
			taskTextDarkColor: '#f9fafb',
			taskTextOutsideColor: '#f9fafb',
			taskBkgColor: '#1d4f78',
			activeTaskBkgColor: '#1d4f78',
			activeTaskBorderColor: '#93c5fd',
			doneTaskBkgColor: '#374151',
			doneTaskBorderColor: '#d1d5db',
			critBkgColor: '#7f1d1d',
			critBorderColor: '#fca5a5',
			sectionBkgColor: '#25364a',
			sectionBkgColor2: '#374151',
		},
	},
	'colorblind-light': {
		startOnLoad: false,
		securityLevel: 'strict',
		theme: 'base',
		fontFamily: 'inherit',
		suppressErrorRendering: true,
		themeVariables: {
			background: '#ffffff',
			primaryColor: '#dbeafe',
			primaryTextColor: '#102a43',
			primaryBorderColor: '#005ea8',
			secondaryColor: '#ffedd5',
			secondaryTextColor: '#5f2800',
			secondaryBorderColor: '#a84700',
			tertiaryColor: '#e0f2fe',
			tertiaryTextColor: '#164e63',
			lineColor: '#475569',
			textColor: '#1f2937',
			taskTextColor: '#102a43',
			taskTextDarkColor: '#102a43',
			taskTextOutsideColor: '#102a43',
			taskBkgColor: '#bfdbfe',
			activeTaskBkgColor: '#bfdbfe',
			activeTaskBorderColor: '#005ea8',
			doneTaskBkgColor: '#cbd5e1',
			doneTaskBorderColor: '#475569',
			critBkgColor: '#ffedd5',
			critBorderColor: '#a84700',
			sectionBkgColor: '#dbeafe',
			sectionBkgColor2: '#ffedd5',
		},
	},
	'colorblind-dark': {
		startOnLoad: false,
		securityLevel: 'strict',
		theme: 'base',
		fontFamily: 'inherit',
		suppressErrorRendering: true,
		themeVariables: {
			background: '#111827',
			primaryColor: '#1e3a5f',
			primaryTextColor: '#f3f4f6',
			primaryBorderColor: '#8bd3ff',
			secondaryColor: '#5f321c',
			secondaryTextColor: '#fff1e6',
			secondaryBorderColor: '#ffb98f',
			tertiaryColor: '#164e63',
			tertiaryTextColor: '#ecfeff',
			lineColor: '#cbd5e1',
			textColor: '#f3f4f6',
			taskTextColor: '#f9fafb',
			taskTextDarkColor: '#f9fafb',
			taskTextOutsideColor: '#f9fafb',
			taskBkgColor: '#1e4f78',
			activeTaskBkgColor: '#1e4f78',
			activeTaskBorderColor: '#8bd3ff',
			doneTaskBkgColor: '#334155',
			doneTaskBorderColor: '#cbd5e1',
			critBkgColor: '#7c2d12',
			critBorderColor: '#fdba74',
			sectionBkgColor: '#25364a',
			sectionBkgColor2: '#5f321c',
		},
	},
};

let loadPromise: Promise<Mermaid> | null = null;
let initializedTheme: MermaidThemeId | null = null;
let operationTail: Promise<void> = Promise.resolve();
let renderCounter = 0;

const svgCache = new Map<string, string>();
const inflightRenders = new Map<string, Promise<string>>();
const MAX_CACHE_SIZE = 64;

function renderKey(source: string, themeId: MermaidThemeId): string {
	return `${themeId}\0${source}`;
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
	const result = operationTail.then(operation, operation);
	operationTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

async function loadMermaid(): Promise<Mermaid> {
	loadPromise ??= import('mermaid').then(({ default: mermaid }) => mermaid);
	return loadPromise;
}

export function resolveMermaidThemeId(presentation: ThemeRendererPresentation): MermaidThemeId {
	return rendererThemeIdFor(presentation);
}

export async function renderMermaid(source: string, themeId: MermaidThemeId): Promise<string> {
	const key = renderKey(source, themeId);
	const cached = svgCache.get(key);
	if (cached) return cached;

	const inflight = inflightRenders.get(key);
	if (inflight) return inflight;

	const promise = enqueue(async () => {
		const queuedCached = svgCache.get(key);
		if (queuedCached) return queuedCached;
		const mermaid = await loadMermaid();
		if (initializedTheme !== themeId) {
			mermaid.initialize(THEME_CONFIGS[themeId]);
			initializedTheme = themeId;
		}
		const id = `mermaid-${++renderCounter}-${Date.now()}`;
		const { svg } = await mermaid.render(id, source);
		if (svgCache.size >= MAX_CACHE_SIZE) {
			const oldest = svgCache.keys().next().value;
			if (oldest !== undefined) svgCache.delete(oldest);
		}
		svgCache.set(key, svg);
		return svg;
	});

	inflightRenders.set(key, promise);
	try {
		return await promise;
	} finally {
		inflightRenders.delete(key);
	}
}
