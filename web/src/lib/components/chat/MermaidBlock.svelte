<!--
@component
Renders mermaid diagram from fenced code block source.
Lazy-loads the mermaid library on first render via mermaid-loader.
-->
<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { renderMermaid } from './mermaid-loader';

	interface Props {
		text?: string;
	}

	let { text = '' }: Props = $props();

	let renderedSvg = $state('');
	let renderError = $state('');
	let loading = $state(true);
	let copied = $state(false);

	async function handleCopy() {
		const didCopy = await copyToClipboard(text);
		if (!didCopy) return;
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	$effect(() => {
		if (!text) return;

		const currentText = text;
		loading = true;
		renderedSvg = '';
		renderError = '';

		renderMermaid(currentText).then(
			(svg) => {
				if (currentText !== text) return;
				renderedSvg = svg;
				loading = false;
			},
			(err) => {
				if (currentText !== text) return;
				renderError = err instanceof Error ? err.message : 'Failed to render diagram';
				loading = false;
			}
		);
	});
</script>

<div class="group relative overflow-hidden rounded-md border border-border bg-muted/30">
	<div
		class="flex items-center gap-1.5 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
	>
		<span>mermaid</span>
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

	<div class="mermaid-container overflow-x-auto p-4">
		{#if loading}
			<div class="flex items-center gap-2 text-sm text-muted-foreground">
				<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
				</svg>
				Rendering diagram...
			</div>
		{:else if renderError}
			<div class="text-sm text-destructive">{renderError}</div>
		{:else}
			{@html renderedSvg}
		{/if}
	</div>
</div>

<style>
	.mermaid-container :global(svg) {
		max-width: 100%;
		height: auto;
	}
</style>
