import { lazyRenderer } from '$lib/utils/lazy-renderer.js';

/** Loads the formatted editor chunk once for both preloading and rendering. */
export const loadComposerMarkdownEditor = lazyRenderer(
	() => import('./ComposerMarkdownEditor.svelte'),
);
