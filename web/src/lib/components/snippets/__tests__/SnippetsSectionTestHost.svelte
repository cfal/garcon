<script lang="ts">
	import SnippetsSection from '../SnippetsSection.svelte';
	import { setSnippets, setTransientLayers } from '$lib/context';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import type { Snippet, SnippetsSnapshot } from '$shared/snippets';

	interface Props {
		blockRefresh?: boolean;
		blockSave?: boolean;
	}

	let { blockRefresh = false, blockSave = false }: Props = $props();

	function entry(id: string, shortName: string, template: string): Snippet {
		return {
			id,
			shortName,
			template,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		};
	}

	let current: SnippetsSnapshot = {
		revision: 1,
		snippets: [entry('one', 'review', 'Review this'), entry('two', 'summarize', 'Summarize this')],
	};
	let loadCount = 0;
	let releaseRefresh: (() => void) | null = null;
	let rejectSave: ((error: Error) => void) | null = null;
	const store = createSnippetsStore({
		get: async () => {
			loadCount += 1;
			if (blockRefresh && loadCount > 1) {
				await new Promise<void>((resolve) => {
					releaseRefresh = resolve;
				});
			}
			return current;
		},
		create: async (request) => {
			if (blockSave) {
				await new Promise<void>((_resolve, reject) => {
					rejectSave = (error) => reject(error);
				});
			}
			current = {
				revision: current.revision + 1,
				snippets: [
					...current.snippets,
					entry(`created-${current.revision}`, request.snippet.shortName, request.snippet.template),
				],
			};
			return { success: true, snapshot: current };
		},
		update: async (request) => {
			current = {
				revision: current.revision + 1,
				snippets: current.snippets.map((snippet) =>
					snippet.id === request.id
						? { ...snippet, ...request.snippet, updatedAt: '2026-01-02T00:00:00.000Z' }
						: snippet,
				),
			};
			return { success: true, snapshot: current };
		},
		remove: async (request) => {
			current = {
				revision: current.revision + 1,
				snippets: current.snippets.filter((snippet) => snippet.id !== request.id),
			};
			return { success: true, snapshot: current };
		},
		reorder: async (request) => {
			const byId = new Map(current.snippets.map((snippet) => [snippet.id, snippet]));
			current = {
				revision: current.revision + 1,
				snippets: request.orderedSnippetIds.map((id) => byId.get(id)!),
			};
			return { success: true, snapshot: current };
		},
	});
	setSnippets(store);
	const transientLayers = new TransientLayerRegistry(new ChatInteractionGate());
	setTransientLayers(transientLayers);
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />

<SnippetsSection active={true} />
<button type="button" onclick={() => void store.refresh()} data-testid="begin-refresh">
	Begin refresh
</button>
<button type="button" onclick={() => releaseRefresh?.()} data-testid="release-refresh">
	Release refresh
</button>
<button
	type="button"
	onclick={() => rejectSave?.(new Error('save failed'))}
	data-testid="reject-save"
>
	Reject save
</button>
