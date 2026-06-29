<!--
@component
Renders a fenced code block with static CodeMirror/Lezer highlighting.
The highlighter loads on demand and the raw source remains visible while
language packages are fetched.
-->
<script module lang="ts">
	import { shouldAttemptCodeFenceHighlight } from '$lib/highlighting/code-language-aliases';
	import {
		plainCodeSegments,
		type CodeHighlightSegment,
	} from '$lib/highlighting/code-highlight-types';

	type HighlighterModule = typeof import('$lib/highlighting/code-fence-highlighter');

	let highlighterPromise: Promise<HighlighterModule> | null = null;

	function loadHighlighter(): Promise<HighlighterModule> {
		highlighterPromise ??= import('$lib/highlighting/code-fence-highlighter');
		return highlighterPromise;
	}
</script>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		lang?: string;
		text?: string;
	}

	let { lang = '', text = '' }: Props = $props();

	const plainSegments = $derived(plainCodeSegments(text));
	let asyncSegments = $state<CodeHighlightSegment[] | null>(null);
	const segments = $derived(asyncSegments ?? plainSegments);
	let highlightToken = 0;

	// Highlights asynchronously while preserving immediate plain-text rendering.
	$effect(() => {
		const currentText = text;
		const currentLang = lang;
		const token = ++highlightToken;

		asyncSegments = null;
		if (!currentText || !shouldAttemptCodeFenceHighlight(currentLang)) return;

		void (async () => {
			try {
				const { highlightCodeFence } = await loadHighlighter();
				const nextSegments = await highlightCodeFence(currentText, currentLang);
				if (token === highlightToken) asyncSegments = nextSegments;
			} catch {
				if (token === highlightToken) asyncSegments = null;
			}
		})();
	});

	let copied = $state(false);
	async function handleCopy() {
		const didCopy = await copyToClipboard(text);
		if (!didCopy) return;
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="markdown-code-block not-prose group relative my-2 overflow-hidden rounded-md border">
	<div
		class="markdown-code-block-header flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px]"
	>
		<span>{lang || 'text'}</span>
		<button
			onclick={handleCopy}
			class="inline-flex h-6 w-6 items-center justify-center rounded opacity-100 transition-opacity [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100 hover:bg-accent"
			title={m.chat_code_block_copy()}
			aria-label={copied ? m.chat_code_block_copied() : m.chat_code_block_copy()}
		>
			{#if copied}
				<svg
					class="w-3 h-3 text-status-success-foreground"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 13l4 4L19 7"
					/>
				</svg>
			{:else}
				<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
					/>
				</svg>
			{/if}
		</button>
	</div>
	<pre class="m-0 overflow-x-auto p-3 text-xs font-mono"><code class="cm-code">{#each segments as segment, index (index)}{#if segment.className}<span class={segment.className}>{segment.text}</span>{:else}{segment.text}{/if}{/each}</code></pre>
</div>
