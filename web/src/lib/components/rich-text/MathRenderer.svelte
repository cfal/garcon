<!--
@component
Renders a tokenized TeX expression through the lazy KaTeX boundary.
Preserves escaped source while loading or when rendering fails.
-->
<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { readCachedMath, renderMath } from '$lib/components/rich-text/katex-loader';

	interface Props {
		text?: string;
		raw?: string;
		displayMode?: boolean;
	}

	let { text = '', raw = '', displayMode = false }: Props = $props();

	const expression = $derived({ text, displayMode });
	const cached = $derived(readCachedMath(expression.text, expression.displayMode));
	let result = $state.raw<{ expression: typeof expression; html: string }>();
	const renderedHtml = $derived(cached ?? (result?.expression === expression ? result.html : ''));
	const renderFailed = $derived(!cached && result?.expression === expression && !result.html);

	const fallbackSource = $derived(raw || (displayMode ? `\\[${text}\\]` : `\\(${text}\\)`));
	const renderStatus = $derived(renderedHtml ? 'rendered' : renderFailed ? 'failed' : 'loading');

	$effect(() => {
		const current = expression;
		result = undefined;
		if (cached !== undefined) return;
		let active = true;

		void renderMath(current.text, current.displayMode).then(
			(html) => {
				if (active) result = { expression: current, html };
			},
			() => {
				if (active) result = { expression: current, html: '' };
			},
		);

		return () => {
			active = false;
		};
	});
</script>

<span
	class="markdown-math not-prose"
	data-chat-layout-pending={renderStatus === 'loading' ? 'true' : undefined}
	data-display={displayMode ? 'true' : 'false'}
	data-render-status={renderStatus}
	title={renderFailed ? m.markdown_math_render_failed() : undefined}
>
	{#if renderedHtml}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- KaTeX generates this markup from math text with trust disabled. -->
		{@html renderedHtml}
	{:else}
		<code
			class="markdown-math-source font-mono text-[0.95em]"
			class:text-destructive={renderFailed}
		>
			{fallbackSource}
		</code>
	{/if}
</span>
