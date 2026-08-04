<script lang="ts">
	import ComposerSnippetPalette from '../ComposerSnippetPalette.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { setAppShell, setLocalSettings, setSnippets, setTransientLayers } from '$lib/context';
	import { AppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import type { Snippet } from '$shared/snippets';
	import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
	import { LocalSettingsStore } from '$lib/stores/local-settings.svelte.js';

	interface Props {
		count?: number;
		failLoads?: boolean;
		firstTemplate?: string;
		initialQuery?: string;
		contextHint?: string | null;
		insertionResult?: SnippetInsertionResult;
	}

	let {
		count = 12,
		failLoads = false,
		firstTemplate,
		initialQuery = '',
		contextHint = null,
		insertionResult = 'inserted',
	}: Props = $props();

	let open = $state(true);
	let interactionKey = $state('chat-a');
	let selected = $state('');
	let selectedArguments = $state('');
	let cancelCount = $state(0);
	let editCount = $state(0);
	let loadCount = $state(0);
	let composerInput = $state<HTMLInputElement>();

	const entries: Snippet[] = Array.from({ length: untrack(() => count) }, (_, index) => ({
		id: `snippet-${index}`,
		shortName: `item-${index}`,
		template:
			index === 0 && firstTemplate !== undefined
				? firstTemplate
				: index % 2 === 0
					? `Review item ${index}`
					: `Summarize item ${index}`,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}));

	const appShell = new AppShellStore();
	const transientLayers = new TransientLayerRegistry(new ChatInteractionGate());
	const localSettings = new LocalSettingsStore();
	localSettings.set('snippetTrigger', ';;');
	setAppShell(appShell);
	setTransientLayers(transientLayers);
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
	const snippetStore = createSnippetsStore({
		get: async () => {
			loadCount += 1;
			if (failLoads) throw new Error('offline');
			return { revision: 1, snippets: entries };
		},
	});
	setSnippets(snippetStore);
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />
<input bind:this={composerInput} aria-label="Composer prompt" />

<ComposerSnippetPalette
	{open}
	onOpenChange={(nextOpen) => (open = nextOpen)}
	{initialQuery}
	interactionKey={interactionKey}
	{contextHint}
	onInsert={(snippet, argumentsText) => {
		selected = snippet.shortName;
		selectedArguments = argumentsText;
		return insertionResult;
	}}
	onCancelled={() => {
		cancelCount += 1;
		composerInput?.focus();
	}}
	onEditSnippets={() => (editCount += 1)}
/>

<button type="button" data-testid="change-interaction-key" onclick={() => (interactionKey = 'chat-b')}
	>Change interaction key</button
>
<button
	type="button"
	data-testid="refresh-snapshot"
	onclick={() =>
		snippetStore.applySnapshot({
			revision: 2,
			snippets: [
				{
					id: 'new-snippet',
					shortName: 'item-new',
					template: 'New item',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
				},
				...entries,
			],
		})}>Refresh snapshot</button
>

<output data-testid="palette-open">{String(open)}</output>
<output data-testid="selected-snippet">{selected}</output>
<output data-testid="selected-arguments">{selectedArguments}</output>
<output data-testid="cancel-count">{cancelCount}</output>
<output data-testid="edit-count">{editCount}</output>
<div data-testid="load-count">{loadCount}</div>
