<script lang="ts">
	import SnippetsSection from '../SnippetsSection.svelte';
	import { ApiError } from '$lib/api/client.js';
	import { setNotifications, setSnippets, setTransientLayers } from '$lib/context';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import {
		SNIPPET_ERROR_CODES,
		sortSnippetsByShortName,
		type Snippet,
		type SnippetsSnapshot,
	} from '$shared/snippets';

	interface Props {
		blockRefresh?: boolean;
		blockSave?: boolean;
		showSection?: boolean;
	}

	let { blockRefresh = false, blockSave = false, showSection = true }: Props = $props();

	function entry(id: string, shortName: string, template: string, defaultArguments = ''): Snippet {
		return {
			id,
			shortName,
			template,
			defaultArguments,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		};
	}

	let current: SnippetsSnapshot = {
		revision: 1,
		snippets: sortSnippetsByShortName([
			entry('two', 'summarize', 'Summarize this'),
			entry('one', 'review', 'Review this'),
		]),
	};
	let loadCount = 0;
	let releaseRefresh: (() => void) | null = null;
	let rejectSave: ((error: Error) => void) | null = null;
	let createCount = $state(0);
	let updateCount = $state(0);
	let lastUpdateExpectedRevision = $state<number | null>(null);
	let lastRemoveExpectedRevision = $state<number | null>(null);

	function revise(snippets: Snippet[]): SnippetsSnapshot {
		current = {
			revision: current.revision + 1,
			snippets: sortSnippetsByShortName(snippets),
		};
		return current;
	}

	function assertRevisionAndTarget(expectedRevision: number, id: string): void {
		if (expectedRevision !== current.revision) {
			throw new ApiError(409, 'Snippets changed', SNIPPET_ERROR_CODES.revisionConflict);
		}
		if (!current.snippets.some((snippet) => snippet.id === id)) {
			throw new ApiError(404, 'Snippet not found', SNIPPET_ERROR_CODES.notFound);
		}
	}

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
			createCount += 1;
			if (blockSave) {
				await new Promise<void>((_resolve, reject) => {
					rejectSave = (error) => reject(error);
				});
			}
			return {
				success: true,
				snapshot: revise([
					...current.snippets,
					entry(
						`created-${current.revision}`,
						request.snippet.shortName,
						request.snippet.template,
						request.snippet.defaultArguments,
					),
				]),
			};
		},
		update: async (request) => {
			updateCount += 1;
			lastUpdateExpectedRevision = request.expectedRevision;
			assertRevisionAndTarget(request.expectedRevision, request.id);
			return {
				success: true,
				snapshot: revise(
					current.snippets.map((snippet) =>
						snippet.id === request.id
							? { ...snippet, ...request.snippet, updatedAt: '2026-01-02T00:00:00.000Z' }
							: snippet,
					),
				),
			};
		},
		remove: async (request) => {
			lastRemoveExpectedRevision = request.expectedRevision;
			assertRevisionAndTarget(request.expectedRevision, request.id);
			return {
				success: true,
				snapshot: revise(current.snippets.filter((snippet) => snippet.id !== request.id)),
			};
		},
	});
	function editServerOnly(): void {
		revise(
			current.snippets.map((snippet) =>
				snippet.id === 'one'
					? { ...snippet, template: 'Server updated without WS', updatedAt: '2026-01-03T00:00:00.000Z' }
					: snippet,
			),
		);
	}
	function renameServerOnly(): void {
		revise(
			current.snippets.map((snippet) =>
				snippet.id === 'one'
					? {
							...snippet,
							shortName: 'review_server_renamed',
							template: 'Renamed without WS',
							updatedAt: '2026-01-04T00:00:00.000Z',
						}
					: snippet,
			),
		);
	}
	function removeServerOnly(): void {
		revise(current.snippets.filter((snippet) => snippet.id !== 'one'));
	}
	function removeServerSameRevision(): void {
		current = {
			...current,
			snippets: current.snippets.filter((snippet) => snippet.id !== 'one'),
		};
	}
	function advanceExternally(): void {
		revise(
			current.snippets.map((snippet) =>
				snippet.shortName === 'review'
					? { ...snippet, template: 'Externally updated', updatedAt: '2026-01-03T00:00:00.000Z' }
					: snippet,
			),
		);
		void store.refreshInBackground();
	}
	function renameExternally(): void {
		revise(
			current.snippets.map((snippet) =>
				snippet.shortName === 'review'
					? {
							...snippet,
							shortName: 'review_renamed',
							template: 'Renamed externally',
							updatedAt: '2026-01-04T00:00:00.000Z',
						}
					: snippet,
			),
		);
		void store.refreshInBackground();
	}
	function removeExternally(): void {
		revise(current.snippets.filter((snippet) => snippet.shortName !== 'review'));
		void store.refreshInBackground();
	}
	setSnippets(store);
	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);
	const notifications = createNotificationsStore();
	setNotifications(notifications);
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />

{#if showSection}
	<SnippetsSection active={true} />
{/if}
<div data-testid="snippet-create-count">{createCount}</div>
<div data-testid="snippet-update-count">{updateCount}</div>
<div data-testid="last-update-expected-revision">{lastUpdateExpectedRevision ?? ''}</div>
<div data-testid="last-remove-expected-revision">{lastRemoveExpectedRevision ?? ''}</div>
<div data-testid="snippet-notifications">
	{notifications.items.map((notification) => notification.message).join('\n')}
</div>
<button type="button" onclick={() => void store.refresh()} data-testid="begin-refresh">
	Begin refresh
</button>
<button type="button" onclick={editServerOnly} data-testid="server-edit-only">
	Server edit only
</button>
<button type="button" onclick={renameServerOnly} data-testid="server-rename-only">
	Server rename only
</button>
<button type="button" onclick={removeServerOnly} data-testid="server-remove-only">
	Server remove only
</button>
<button type="button" onclick={removeServerSameRevision} data-testid="server-remove-same-revision">
	Server remove same revision
</button>
<button type="button" onclick={advanceExternally} data-testid="external-edit">
	External edit
</button>
<button type="button" onclick={renameExternally} data-testid="external-rename">
	External rename
</button>
<button type="button" onclick={removeExternally} data-testid="external-remove">
	External remove
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
