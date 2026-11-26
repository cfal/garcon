<!--
@component
Renders highlighted token spans without adding layout or presentation wrappers.
The raw source remains visible while the language package loads.
-->
<script module lang="ts">
	import {
		plainCodeSegments,
		type CodeHighlightSegment,
	} from '$lib/highlighting/code-highlight-types';
	import { shouldAttemptCodeFenceHighlight } from '$lib/highlighting/code-language-aliases';
	import { readCachedCodeFence } from '$lib/highlighting/code-highlight-cache';

	type HighlighterModule = typeof import('$lib/highlighting/code-fence-highlighter');

	let highlighterPromise: Promise<HighlighterModule> | null = null;

	function loadHighlighter(): Promise<HighlighterModule> {
		highlighterPromise ??= import('$lib/highlighting/code-fence-highlighter').catch((error: unknown) => {
			highlighterPromise = null;
			throw error;
		});
		return highlighterPromise;
	}
</script>

<script lang="ts">
	interface Props {
		language?: string;
		text?: string;
	}

	let { language = '', text = '' }: Props = $props();

	const plainSegments = $derived(plainCodeSegments(text));
	const input = $derived({ text, language });
	const cached = $derived(readCachedCodeFence(input.text, input.language));
	let highlighted = $state.raw<{ input: typeof input; segments: CodeHighlightSegment[] }>();
	const segments = $derived(
		cached ?? (highlighted?.input === input ? highlighted.segments : plainSegments),
	);

	// Highlights asynchronously while preserving immediate plain-text rendering.
	$effect(() => {
		const current = input;
		highlighted = undefined;
		if (cached || !current.text || !shouldAttemptCodeFenceHighlight(current.language)) return;
		const abort = new AbortController();

		void (async () => {
			try {
				const { highlightCodeFence } = await loadHighlighter();
				if (abort.signal.aborted) return;
				const nextSegments = await highlightCodeFence(current.text, current.language, abort.signal);
				if (!abort.signal.aborted) highlighted = { input: current, segments: nextSegments };
			} catch {
				// Plain text remains visible when the lazy highlighter cannot load.
			}
		})();

		return () => abort.abort();
	});
</script>

{#each segments as segment, index (index)}{#if segment.className}<span class={segment.className}
			>{segment.text}</span
		>{:else}{segment.text}{/if}{/each}
