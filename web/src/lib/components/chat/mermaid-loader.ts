import type { MermaidConfig } from 'mermaid';
import {
	rendererThemeIdFor,
	type RendererThemeId,
	type ThemeRendererPresentation,
} from '$lib/theme/themes.js';

type Mermaid = typeof import('mermaid').default;
export type MermaidThemeId = RendererThemeId;

const BASE_MERMAID_CONFIG = {
	startOnLoad: false,
	securityLevel: 'strict',
	fontFamily: 'inherit',
	suppressErrorRendering: true,
} as const satisfies MermaidConfig;

const THEME_CONFIGS: Record<MermaidThemeId, MermaidConfig> = {
	'standard-light': {
		...BASE_MERMAID_CONFIG,
		theme: 'default',
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
		...BASE_MERMAID_CONFIG,
		theme: 'dark',
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
		...BASE_MERMAID_CONFIG,
		theme: 'base',
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
		...BASE_MERMAID_CONFIG,
		theme: 'base',
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
	'owl-light': {
		...BASE_MERMAID_CONFIG,
		theme: 'base',
		themeVariables: {
			background: '#fbfbfb',
			primaryColor: '#d7efec',
			primaryTextColor: '#403f53',
			primaryBorderColor: '#08757a',
			secondaryColor: '#d3e8f8',
			secondaryTextColor: '#403f53',
			secondaryBorderColor: '#315fbd',
			tertiaryColor: '#ebdff3',
			tertiaryTextColor: '#403f53',
			lineColor: '#5f6b73',
			textColor: '#403f53',
			taskTextColor: '#403f53',
			taskTextDarkColor: '#403f53',
			taskTextOutsideColor: '#403f53',
			taskBkgColor: '#d3e8f8',
			activeTaskBkgColor: '#d3e8f8',
			activeTaskBorderColor: '#315fbd',
			doneTaskBkgColor: '#e0e7ea',
			doneTaskBorderColor: '#5f6b73',
			critBkgColor: '#f3dddd',
			critBorderColor: '#9f2f2f',
			sectionBkgColor: '#d7efec',
			sectionBkgColor2: '#d3e8f8',
		},
	},
	'owl-dark': {
		...BASE_MERMAID_CONFIG,
		theme: 'base',
		themeVariables: {
			background: '#011627',
			primaryColor: '#143d50',
			primaryTextColor: '#d6deeb',
			primaryBorderColor: '#7fdbca',
			secondaryColor: '#32233d',
			secondaryTextColor: '#f2e8f7',
			secondaryBorderColor: '#c792ea',
			tertiaryColor: '#0b2942',
			tertiaryTextColor: '#d6deeb',
			lineColor: '#90a7b2',
			textColor: '#d6deeb',
			taskTextColor: '#d6deeb',
			taskTextDarkColor: '#d6deeb',
			taskTextOutsideColor: '#d6deeb',
			taskBkgColor: '#17445a',
			activeTaskBkgColor: '#17445a',
			activeTaskBorderColor: '#82aaff',
			doneTaskBkgColor: '#173247',
			doneTaskBorderColor: '#90a7b2',
			critBkgColor: '#592b35',
			critBorderColor: '#ef5350',
			sectionBkgColor: '#143d50',
			sectionBkgColor2: '#32233d',
		},
	},
	'neko-light': {
		...BASE_MERMAID_CONFIG,
		theme: 'base',
		themeVariables: {
			background: '#eff1f5',
			primaryColor: '#e7ddf3',
			primaryTextColor: '#4c4f69',
			primaryBorderColor: '#8839ef',
			secondaryColor: '#dce7fb',
			secondaryTextColor: '#4c4f69',
			secondaryBorderColor: '#2455b8',
			tertiaryColor: '#deebdc',
			tertiaryTextColor: '#4c4f69',
			lineColor: '#5c5f77',
			textColor: '#4c4f69',
			taskTextColor: '#4c4f69',
			taskTextDarkColor: '#4c4f69',
			taskTextOutsideColor: '#4c4f69',
			taskBkgColor: '#dce7fb',
			activeTaskBkgColor: '#dce7fb',
			activeTaskBorderColor: '#2455b8',
			doneTaskBkgColor: '#dce0e8',
			doneTaskBorderColor: '#5c5f77',
			critBkgColor: '#f3dce2',
			critBorderColor: '#d20f39',
			sectionBkgColor: '#e7ddf3',
			sectionBkgColor2: '#deebdc',
		},
	},
	'neko-dark': {
		...BASE_MERMAID_CONFIG,
		theme: 'base',
		themeVariables: {
			background: '#1e1e2e',
			primaryColor: '#49375e',
			primaryTextColor: '#cdd6f4',
			primaryBorderColor: '#cba6f7',
			secondaryColor: '#293955',
			secondaryTextColor: '#cdd6f4',
			secondaryBorderColor: '#89b4fa',
			tertiaryColor: '#29453f',
			tertiaryTextColor: '#cdd6f4',
			lineColor: '#9399b2',
			textColor: '#cdd6f4',
			taskTextColor: '#cdd6f4',
			taskTextDarkColor: '#cdd6f4',
			taskTextOutsideColor: '#cdd6f4',
			taskBkgColor: '#293955',
			activeTaskBkgColor: '#293955',
			activeTaskBorderColor: '#89b4fa',
			doneTaskBkgColor: '#313244',
			doneTaskBorderColor: '#9399b2',
			critBkgColor: '#553142',
			critBorderColor: '#f38ba8',
			sectionBkgColor: '#49375e',
			sectionBkgColor2: '#29453f',
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
