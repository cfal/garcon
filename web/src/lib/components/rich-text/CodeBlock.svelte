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
	import { onDestroy } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import HighlightedCodeText from '$lib/components/rich-text/HighlightedCodeText.svelte';

	interface Props {
		lang?: string;
		text?: string;
	}

	let { lang = '', text = '' }: Props = $props();

	const wrapsCodeBlock = $derived(shouldWrapCodeFenceLanguage(lang));
	const preClass = $derived(
		wrapsCodeBlock
			? 'm-0 overflow-x-hidden whitespace-pre-wrap break-words text-xs font-mono'
			: 'm-0 overflow-x-auto whitespace-pre text-xs font-mono',
	);
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;
	async function handleCopy() {
		const didCopy = await copyToClipboard(text);
		if (!didCopy) return;
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied = false;
			copyTimer = null;
		}, 2000);
	}
	onDestroy(() => {
		if (copyTimer) clearTimeout(copyTimer);
	});
</script>

<div
	class="markdown-code-block not-prose group relative my-2 overflow-hidden rounded-md border"
	data-wrap={wrapsCodeBlock ? 'true' : 'false'}
>
	<div class={lang
		? 'flex items-center gap-2 px-3 pt-2 pb-0.5 text-[11px] leading-none'
		: 'absolute right-1.5 top-1.5 z-10'}>
		{#if lang}
			<span class="shrink-0 font-medium text-muted-foreground tracking-wide">{lang}</span>
		{/if}
		<button
			type="button"
			onclick={handleCopy}
			class={[
				'inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100',
				lang ? 'size-5' : 'size-7 rounded-md border border-border/70 bg-background shadow-sm hover:bg-accent',
			]}
			title={m.chat_code_block_copy()}
			aria-label={copied ? m.chat_code_block_copied() : m.chat_code_block_copy()}
		>
			{#if copied}
				<Check class="size-3 text-status-success-foreground" />
			{:else}
				<Copy class="size-3" />
			{/if}
		</button>
	</div>
	<pre class={[preClass, lang ? 'px-3 pb-3 pt-1' : 'min-h-10 p-3 pr-11']}><code class="cm-code"><HighlightedCodeText {text} language={lang} /></code
		></pre>
</div>
