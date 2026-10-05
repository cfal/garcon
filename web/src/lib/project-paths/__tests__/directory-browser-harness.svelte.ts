import { flushSync } from 'svelte';
import { DirectoryBrowserState } from '../directory-browser-state.svelte.js';

export interface DirectoryBrowserHarnessOptions {
	executorId?: string;
	executorContextKey?: string;
	currentPath?: string;
	basePath?: string;
	confirmsSelection?: boolean;
}

/** Runs a browser against a path field that applies each published selection. */
export function openDirectoryBrowser(initial: DirectoryBrowserHarnessOptions = {}) {
	let executorId = $state(initial.executorId ?? 'local');
	let executorContextKey = $state(initial.executorContextKey ?? 'instance-1');
	let currentPath = $state(initial.currentPath ?? '');
	let basePath = $state(initial.basePath ?? '/repo');
	const confirmsSelection = initial.confirmsSelection ?? false;
	const selections: string[] = [];
	let closes = 0;
	const browser = new DirectoryBrowserState({
		get executorId() {
			return executorId;
		},
		get executorContextKey() {
			return executorContextKey;
		},
		get currentPath() {
			return currentPath;
		},
		get basePath() {
			return basePath;
		},
		get confirmsSelection() {
			return confirmsSelection;
		},
		onSelect(path) {
			selections.push(path);
			currentPath = path;
		},
		onClose() {
			closes += 1;
		},
	});
	const dispose = $effect.root(() => {
		$effect(() => browser.trackListing());
	});
	flushSync();
	return {
		browser,
		selections,
		dispose,
		get closes() {
			return closes;
		},
		get currentPath() {
			return currentPath;
		},
		type(path: string) {
			currentPath = path;
			flushSync();
		},
		resolveBase(path: string) {
			basePath = path;
			flushSync();
		},
		switchExecutor(nextExecutorId: string, nextContextKey: string) {
			executorId = nextExecutorId;
			executorContextKey = nextContextKey;
			flushSync();
		},
		replaceServingInstance(nextContextKey: string) {
			executorContextKey = nextContextKey;
			flushSync();
		},
	};
}
