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

	type HighlighterModule = typeof import('$lib/highlighting/code-fence-highlighter');

	let highlighterPromise: Promise<HighlighterModule> | null = null;

	function loadHighlighter(): Promise<HighlighterModule> {
		highlighterPromise ??= import('$lib/highlighting/code-fence-highlighter');
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
	let asyncSegments = $state<CodeHighlightSegment[] | null>(null);
	const segments = $derived(asyncSegments ?? plainSegments);

	// Highlights asynchronously while preserving immediate plain-text rendering.
	$effect(() => {
		const currentText = text;
		const currentLanguage = language;
		let cancelled = false;

		asyncSegments = null;
		if (!currentText || !shouldAttemptCodeFenceHighlight(currentLanguage)) return;

		void (async () => {
			try {
				const { highlightCodeFence } = await loadHighlighter();
				const nextSegments = await highlightCodeFence(currentText, currentLanguage);
				if (!cancelled) asyncSegments = nextSegments;
			} catch {
				if (!cancelled) asyncSegments = null;
			}
		})();

		return () => {
			cancelled = true;
		};
	});
</script>

{#each segments as segment, index (index)}{#if segment.className}<span class={segment.className}
			>{segment.text}</span
		>{:else}{segment.text}{/if}{/each}
