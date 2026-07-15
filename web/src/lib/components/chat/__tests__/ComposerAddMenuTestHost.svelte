<script lang="ts">
	import ComposerAddMenu from '../ComposerAddMenu.svelte';
	import { untrack } from 'svelte';
	import { setAppShell, setSnippets } from '$lib/context';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { AppShellStore } from '$lib/stores/app-shell.svelte.js';
	import type { Snippet } from '$shared/snippets';

	interface Props {
		mobile?: boolean;
		canAttachImages?: boolean;
		count?: number;
		failLoads?: boolean;
	}

	let { mobile = false, canAttachImages = false, count = 12, failLoads = false }: Props = $props();
	let selected = $state('');
	let editCount = $state(0);
	let loadCount = $state(0);
	let composerInput = $state<HTMLInputElement>();
	const entries: Snippet[] = Array.from({ length: untrack(() => count) }, (_, index) => ({
		id: `snippet-${index}`,
		shortName: `item-${index}`,
		template: index % 2 === 0 ? `Review item ${index}` : `Summarize item ${index}`,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}));

	const appShell = new AppShellStore();
	appShell.isMobile = untrack(() => mobile);
	setAppShell(appShell);
	setSnippets(
		createSnippetsStore({
			get: async () => {
				loadCount += 1;
				if (failLoads) throw new Error('offline');
				return { revision: 1, snippets: entries };
			},
		}),
	);
</script>

<input bind:this={composerInput} aria-label="Composer prompt" />
<ComposerAddMenu
	{canAttachImages}
	attachImagesTooltip="Images are unavailable"
	onAddImage={() => undefined}
	onInsertSnippet={(snippet) => (selected = snippet.shortName)}
	onEditSnippets={() => (editCount += 1)}
	onRequestComposerFocus={() => composerInput?.focus()}
/>

<output data-testid="selected-snippet">{selected}</output>
<output data-testid="edit-count">{editCount}</output>
<div data-testid="load-count">{loadCount}</div>
