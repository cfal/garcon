<!--
@component
Renders a tokenized TeX expression through the lazy KaTeX boundary.
Preserves escaped source while loading or when rendering fails.
-->
<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { renderMath } from './katex-loader';

	interface Props {
		text?: string;
		raw?: string;
		displayMode?: boolean;
	}

	let { text = '', raw = '', displayMode = false }: Props = $props();

	let renderedHtml = $state('');
	let renderFailed = $state(false);
	let requestVersion = 0;

	const fallbackSource = $derived(raw || (displayMode ? `\\[${text}\\]` : `\\(${text}\\)`));
	const renderStatus = $derived(renderedHtml ? 'rendered' : renderFailed ? 'failed' : 'loading');

	$effect(() => {
		const request = ++requestVersion;
		const currentText = text;
		const currentDisplayMode = displayMode;

		renderedHtml = '';
		renderFailed = false;

		void renderMath(currentText, currentDisplayMode).then(
			(html) => {
				if (request !== requestVersion) return;
				renderedHtml = html;
			},
			() => {
				if (request !== requestVersion) return;
				renderFailed = true;
			},
		);

		return () => {
			if (request === requestVersion) requestVersion += 1;
		};
	});
</script>

<span
	class="markdown-math not-prose"
	data-display={displayMode ? 'true' : 'false'}
	data-render-status={renderStatus}
	title={renderFailed ? m.markdown_math_render_failed() : undefined}
>
	{#if renderedHtml}
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
