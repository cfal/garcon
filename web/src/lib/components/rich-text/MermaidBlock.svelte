<!--
@component
Renders mermaid diagram from fenced code block source.
Lazy-loads the mermaid library on first render via mermaid-loader.
-->
<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MermaidViewerDialog from '$lib/components/rich-text/MermaidViewerDialog.svelte';
	import { renderMermaid, resolveMermaidThemeId } from '$lib/components/rich-text/mermaid-loader';
	import { getThemeRuntime } from '$lib/context';

	interface Props {
		text?: string;
		acquireTransientActivity?: (close: () => void) => () => void;
	}

	let { text = '', acquireTransientActivity }: Props = $props();
	const theme = getThemeRuntime();
	const mermaidThemeId = $derived(
		resolveMermaidThemeId({
			colorScheme: theme.profile.colorScheme,
			rendererPalette: theme.profile.rendererPalette,
		}),
	);

	let renderedSvg = $state('');
	let renderedSource = $state('');
	let renderError = $state('');
	let loading = $state(true);
	let viewerOpen = $state(false);
	let releaseViewer: (() => void) | null = null;

	function openViewer(): void {
		releaseViewer ??= acquireTransientActivity?.(() => void closeViewer()) ?? null;
		viewerOpen = true;
	}

	async function closeViewer(): Promise<void> {
		const release = releaseViewer;
		releaseViewer = null;
		viewerOpen = false;
		await tick();
		release?.();
	}

	function handleViewerOpenChange(open: boolean): void {
		if (open) openViewer();
		else void closeViewer();
	}

	$effect(() => {
		if (!text) {
			loading = false;
			renderedSvg = '';
			renderedSource = '';
			renderError = '';
			return;
		}

		const currentText = text;
		const currentThemeId = mermaidThemeId;
		loading = true;
		if (untrack(() => renderedSource !== currentText)) {
			renderedSvg = '';
			renderedSource = '';
		}
		renderError = '';

		let active = true;
		const isCurrentRender = () =>
			active && currentText === text && currentThemeId === mermaidThemeId;
		renderMermaid(currentText, currentThemeId).then(
			(svg) => {
				if (!isCurrentRender()) return;
				renderedSvg = svg;
				renderedSource = currentText;
				loading = false;
			},
			(error) => {
				if (!isCurrentRender()) return;
				renderedSvg = '';
				renderedSource = '';
				renderError = error instanceof Error ? error.message : m.chat_mermaid_render_failed();
				loading = false;
			},
		);
		return () => {
			active = false;
		};
	});

	onDestroy(() => {
		releaseViewer?.();
	});
</script>

<div class="mermaid-container" data-chat-layout-pending={loading ? 'true' : undefined}>
	{#if loading && !renderedSvg}
		<div role="status" class="flex h-8 items-center text-muted-foreground">
			<LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
			<span class="sr-only">{m.chat_mermaid_rendering()}</span>
		</div>
	{:else if renderError}
		<div class="text-sm text-destructive">{renderError}</div>
	{:else if renderedSvg}
		<div class="mermaid-thumbnail">
			<!-- Inert artwork prevents diagram links from competing with viewer activation. -->
			<div class="mermaid-thumbnail-artwork" inert aria-hidden="true">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- Mermaid generates this SVG in strict security mode. -->
				{@html renderedSvg}
			</div>
			<button
				type="button"
				class="mermaid-thumbnail-open focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onclick={openViewer}
				aria-label={m.chat_mermaid_expand()}
				aria-haspopup="dialog"
				disabled={loading}
			></button>
		</div>
	{/if}
</div>

<MermaidViewerDialog
	open={viewerOpen}
	source={renderedSource}
	svg={renderedSvg}
	onOpenChange={handleViewerOpenChange}
/>

<style>
	.mermaid-container {
		--mermaid-thumbnail-width: 640px;
		--mermaid-thumbnail-height: 320px;
		max-width: 100%;
	}

	:global([data-inline-mermaid-thumbnail-size='small']) .mermaid-container {
		--mermaid-thumbnail-width: 320px;
		--mermaid-thumbnail-height: 180px;
	}

	:global([data-inline-mermaid-thumbnail-size='large']) .mermaid-container {
		--mermaid-thumbnail-width: 960px;
		--mermaid-thumbnail-height: 480px;
	}

	:global([data-inline-mermaid-thumbnail-size='full']) .mermaid-container {
		--mermaid-thumbnail-width: 100%;
		--mermaid-thumbnail-height: none;
	}

	.mermaid-thumbnail {
		position: relative;
		width: 100%;
		max-width: var(--mermaid-thumbnail-width);
	}

	.mermaid-thumbnail-open {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: none;
		cursor: zoom-in;
	}

	.mermaid-thumbnail-artwork > :global(svg) {
		display: block;
		width: auto;
		max-width: 100%;
		max-height: var(--mermaid-thumbnail-height);
		height: auto;
	}
</style>
