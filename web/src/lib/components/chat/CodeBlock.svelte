<!--
@component
Renders a fenced code block with static CodeMirror/Lezer highlighting.
The highlighter loads on demand and the raw source remains visible while
language packages are fetched.
-->
<script module lang="ts">
	import { shouldWrapCodeFenceLanguage } from '$lib/highlighting/code-language-aliases';
</script>

<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import HighlightedCodeText from './HighlightedCodeText.svelte';

	interface Props {
		lang?: string;
		text?: string;
	}

	let { lang = '', text = '' }: Props = $props();

	const wrapsCodeBlock = $derived(shouldWrapCodeFenceLanguage(lang));
	const preClass = $derived(
		wrapsCodeBlock
			? 'm-0 overflow-x-hidden whitespace-pre-wrap break-words px-3 pb-3 pt-1 text-xs font-mono'
			: 'm-0 overflow-x-auto whitespace-pre px-3 pb-3 pt-1 text-xs font-mono',
	);
	let copied = $state(false);
	async function handleCopy() {
		const didCopy = await copyToClipboard(text);
		if (!didCopy) return;
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div
	class="markdown-code-block not-prose group relative my-2 overflow-hidden rounded-md border"
	data-wrap={wrapsCodeBlock ? 'true' : 'false'}
>
	<div class="flex items-center gap-2 px-3 pt-2 pb-0.5 text-[11px] leading-none">
		<span class="shrink-0 font-medium text-muted-foreground tracking-wide">{lang || 'text'}</span>
		<button
			type="button"
			onclick={handleCopy}
			class="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100"
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
	<pre class={preClass}><code class="cm-code"><HighlightedCodeText {text} language={lang} /></code
		></pre>
</div>
